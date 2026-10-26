// Agent Huddle for macOS. By default it runs everything on this Mac: the chat server and the agent
// runner start in the background (local/start.mjs, with the Node.js bundled in the app), and each
// agent uses the CLI signed in on this Mac. It can also open the cloud version instead.
// Build with ./build.sh (needs Xcode or the Command Line Tools: `xcode-select --install`).
import Cocoa
import WebKit
import UserNotifications
import Security
import Sparkle   // auto-updates (bundled by build.sh)

let defaultServer = "" // set with Agent Huddle → Cloud Address… if you also run the cloud version
let supportDir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("Agent Huddle", isDirectory: true)
let configURL = supportDir.appendingPathComponent("config.json")

/// Settings shared with local/start.mjs (passwords, relay token, keep-awake, sandbox). Private to you (0600).
func readConfig() -> [String: Any] {
    guard let data = try? Data(contentsOf: configURL),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return obj
}
func writeConfig(_ c: [String: Any]) {
    try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true,
                                             attributes: [.posixPermissions: 0o700])
    guard let data = try? JSONSerialization.data(withJSONObject: c, options: [.prettyPrinted, .sortedKeys]) else { return }
    try? data.write(to: configURL, options: .atomic)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
}

// MARK: Secrets — kept in your login Keychain, never in files.
// The app password (also used on your phone), the runner's secret, the 256-bit key that encrypts
// Agent Huddle's database, and the phone relay's tunnel token.
enum Keychain {
    static let service = "Agent Huddle"
    private static func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    static func get(_ account: String) -> String? {
        var q = base(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
    @discardableResult static func set(_ account: String, _ value: String) -> Bool {
        let data = Data(value.utf8)
        let st = SecItemUpdate(base(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if st != errSecItemNotFound { return st == errSecSuccess }
        var add = base(account)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
}
func randomBytes(_ n: Int) -> [UInt8] {
    var b = [UInt8](repeating: 0, count: n)
    _ = SecRandomCopyBytes(kSecRandomDefault, n, &b)
    return b
}
func randomHex(_ n: Int) -> String { randomBytes(n).map { String(format: "%02x", $0) }.joined() }
func randomToken(_ n: Int) -> String {
    Data(randomBytes(n)).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
/// If the Keychain refuses (it can after a rebuild that isn't signed with a Developer ID), the secrets go
/// in this private file instead, so the server, the sign-in and the database key always agree.
let secretsFileURL = supportDir.appendingPathComponent("secrets.json")
private var secretsCache: [String: String]?
/// The app's secrets, created on first launch and read once per run. Anything left in config.json by an
/// older version moves here.
func loadSecrets() -> [String: String] {
    if let c = secretsCache { return c }
    var s: [String: String] = [:]
    let parse = { (d: Data) in (try? JSONSerialization.jsonObject(with: d)) as? [String: String] }
    if let json = Keychain.get("secrets"), let d = json.data(using: .utf8), let obj = parse(d) { s = obj }
    else if let d = try? Data(contentsOf: secretsFileURL), let obj = parse(d) { s = obj }
    var changed = false
    var cfg = readConfig()
    for k in ["password", "runnerSecret", "relayToken"] {
        if let v = cfg[k] as? String { if s[k] == nil { s[k] = v }; cfg.removeValue(forKey: k); changed = true }
    }
    if changed { writeConfig(cfg) }
    if s["password"] == nil { s["password"] = randomToken(18); changed = true }
    if s["runnerSecret"] == nil { s["runnerSecret"] = randomToken(32); changed = true }
    if s["dbKey"] == nil { s["dbKey"] = randomHex(32); changed = true }
    if changed { saveSecrets(s) }
    secretsCache = s
    return s
}
func saveSecrets(_ s: [String: String]) {
    secretsCache = s
    guard let d = try? JSONSerialization.data(withJSONObject: s), let json = String(data: d, encoding: .utf8) else { return }
    if Keychain.set("secrets", json), Keychain.get("secrets") == json {
        try? FileManager.default.removeItem(at: secretsFileURL)
    } else {
        try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? d.write(to: secretsFileURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: secretsFileURL.path)
    }
}

/// Runs local/start.mjs and reports when the server is ready. Closing its stdin (or quitting) stops it.
final class LocalServer {
    private var process: Process?
    private var stdinPipe: Pipe?
    private var buffer = ""
    var onReady: ((URL) -> Void)?
    var onFail: ((String) -> Void)?

    func start() {
        stop()
        guard let res = Bundle.main.resourceURL else { return }
        let node = res.appendingPathComponent("node/bin/node")
        let script = res.appendingPathComponent("app/local/start.mjs")
        guard FileManager.default.isExecutableFile(atPath: node.path) else {
            onFail?("Node.js is missing from the app. Rebuild it with macos/build.sh."); return
        }
        let logs = supportDir.appendingPathComponent("logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let logFile = logs.appendingPathComponent("launcher.log")
        if !FileManager.default.fileExists(atPath: logFile.path) { FileManager.default.createFile(atPath: logFile.path, contents: nil) }
        let errHandle = try? FileHandle(forWritingTo: logFile)
        errHandle?.seekToEndOfFile()

        let p = Process()
        p.executableURL = node
        p.arguments = [script.path]
        let inPipe = Pipe(), outPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = errHandle ?? FileHandle.nullDevice
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { h.readabilityHandler = nil; return }
            let text = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async { self?.consume(text) }
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self = self, self.process === proc else { return } // stopped on purpose
                self.process = nil
                self.onFail?("Agent Huddle's server stopped (code \(proc.terminationStatus)). See logs in the Agent Huddle folder.")
            }
        }
        do { try p.run() } catch { onFail?("Couldn't start Agent Huddle: \(error.localizedDescription)"); return }
        process = p; stdinPipe = inPipe; buffer = ""
        // The secrets go to the launcher as the first line on its stdin (never in files or its environment).
        if let d = try? JSONSerialization.data(withJSONObject: loadSecrets()) {
            inPipe.fileHandleForWriting.write(d)
            inPipe.fileHandleForWriting.write(Data("\n".utf8))
        }
    }

    private func consume(_ text: String) {
        buffer += text
        while let r = buffer.range(of: "\n") {
            let line = String(buffer[..<r.lowerBound])
            buffer.removeSubrange(buffer.startIndex..<r.upperBound)
            if line.hasPrefix("READY "),
               let data = String(line.dropFirst(6)).data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let u = obj["url"] as? String, let url = URL(string: u) {
                onReady?(url)
            } else if line.hasPrefix("FAILED ") {
                onFail?(String(line.dropFirst(7)))
            }
        }
    }

    func stop() {
        guard let p = process else { return }
        process = nil
        try? stdinPipe?.fileHandleForWriting.close()
        stdinPipe = nil
        if p.isRunning { p.terminate() } // the launcher stops the server, runner, relay and keep-awake
        let deadline = Date().addingTimeInterval(6)
        while p.isRunning && Date() < deadline { usleep(100_000) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
                         WKScriptMessageHandler, UNUserNotificationCenterDelegate, NSWindowDelegate, NSMenuItemValidation {
    var window: NSWindow!
    var webView: WKWebView!
    var unread = 0 { didSet { NSApp.dockTile.badgeLabel = unread > 0 ? "\(unread)" : nil } }
    let local = LocalServer()
    var localURL: URL?
    var triedAutoSignIn = false
    /// Sparkle: checks updates.agenthuddle.net/appcast.xml daily and installs signed updates.
    var updater: SPUStandardUpdaterController!

    /// "local" (default): agents run on this Mac. "cloud": open the Cloudflare version.
    var isLocal: Bool { (UserDefaults.standard.string(forKey: "mode") ?? "local") == "local" }
    var cloudURL: URL? {
        let s = UserDefaults.standard.string(forKey: "serverURL") ?? defaultServer
        guard let u = URL(string: s), u.scheme == "https" || u.scheme == "http", u.host != nil else { return nil }
        return u
    }
    var serverURL: URL { isLocal ? (localURL ?? URL(string: "http://127.0.0.1:18787/")!) : (cloudURL ?? URL(string: "http://127.0.0.1:18787/")!) }

    func applicationDidFinishLaunching(_ note: Notification) {
        updater = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        buildMenu()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()               // keeps you signed in between launches
        config.userContentController.add(self, name: "agenthuddle")
        config.applicationNameForUserAgent = "AgentHuddleMac/1.0"

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground")  // no white flash in dark mode

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Agent Huddle"
        window.minSize = NSSize(width: 420, height: 520)
        window.contentView = webView
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("AgentHuddleMain")
        window.makeKeyAndOrderFront(nil)

        local.onReady = { [weak self] url in
            guard let self = self else { return }
            self.localURL = url; self.triedAutoSignIn = false
            self.webView.load(URLRequest(url: url))
        }
        local.onFail = { [weak self] msg in self?.showStatus("Agent Huddle couldn't start", msg) }
        startServer()

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationWillTerminate(_ note: Notification) { local.stop() }

    func startServer() {
        if isLocal {
            showStatus("Starting your agents…", "The first launch after an update takes a little longer.")
            local.start()
        } else if let u = cloudURL {
            local.stop()
            webView.load(URLRequest(url: u))
        } else {
            UserDefaults.standard.set("local", forKey: "mode")
            startServer()
        }
    }

    func showStatus(_ title: String, _ detail: String) {
        func h(_ s: String) -> String {
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        }
        let html = """
        <html><body style="font:15px -apple-system;display:grid;place-items:center;height:100vh;margin:0;background:#191918;color:#ecebe8">
        <div style="text-align:center;max-width:460px"><h2>\(h(title))</h2><p style="color:#9b988f">\(h(detail))</p></div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // Sign in automatically on this Mac with the password the launcher made (the same one your phone uses).
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isLocal, !triedAutoSignIn, let url = webView.url, url.host == serverURL.host,
              (webView.title ?? "").contains("Sign in"),
              let pw = loadSecrets()["password"],
              let data = try? JSONSerialization.data(withJSONObject: [pw]),
              let arg = String(data: data, encoding: .utf8) else { return }
        triedAutoSignIn = true
        webView.evaluateJavaScript("fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:\(arg)[0]})}).then(r=>{if(r.ok)location.replace('/');else{const e=document.querySelector('.err,#err');if(e)e.textContent='Automatic sign-in failed. Quit any other copy of Agent Huddle or Agent Room, then choose Agent Huddle → Restart Agents.'}})")
    }

    /// Agent Huddle → Sign In Again: retries the automatic sign-in (e.g. after the server restarted).
    @objc func signInAgain() {
        triedAutoSignIn = false
        if isLocal, let u = localURL { webView.load(URLRequest(url: u)) } else { startServer() }
    }

    // Closing the window keeps the app (and your agents' replies) running; click the Dock icon to bring it back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }
    func applicationDidBecomeActive(_ note: Notification) { unread = 0 }
    func windowDidBecomeKey(_ note: Notification) { unread = 0 }

    // MARK: Links — keep the app on your Agent Huddle; open everything else in your browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        let sameHost = url.host == serverURL.host && url.scheme == serverURL.scheme
        if sameHost || url.scheme == "about" || url.scheme == "blob" { return decisionHandler(.allow) }
        // Anything else leaves the app: only plain web links, never file:, custom app schemes or data: pages.
        if url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
        return nil
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        let html = """
        <html><body style="font:15px -apple-system;display:grid;place-items:center;height:100vh;margin:0;background:#191918;color:#ecebe8">
        <div style="text-align:center"><h2>Can't reach Agent Huddle</h2><p style="color:#9b988f">\(error.localizedDescription)</p>
        <p style="color:#9b988f">Press ⌘R to try again\(isLocal ? ", or choose Agent Huddle → Restart Agents" : "").</p></div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // JavaScript alerts / confirms (used by Clear, Delete and New room).
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.window.initialFirstResponder = field
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    // MARK: Notifications from the page (an agent replied while the window wasn't focused).
    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == serverURL.host,
              let body = message.body as? [String: Any], body["type"] as? String == "notify" else { return }
        if NSApp.isActive && window.isKeyWindow { return }
        unread += 1
        let content = UNMutableNotificationContent()
        content.title = body["title"] as? String ?? "Agent Huddle"
        content.body = body["body"] as? String ?? ""
        content.sound = .default
        if let room = body["roomId"] as? String { content.userInfo = ["roomId": room] }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        if let room = response.notification.request.content.userInfo["roomId"] as? String,
           let data = try? JSONSerialization.data(withJSONObject: [room]),
           let arg = String(data: data, encoding: .utf8) {
            webView.evaluateJavaScript("window.agentRoomOpen && window.agentRoomOpen(...\(arg))")
        }
        done()
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent n: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }

    // MARK: Menu
    @objc func reload() {
        if isLocal && localURL == nil { startServer() } else { webView.load(URLRequest(url: serverURL)) }
    }
    @objc func useLocal() { UserDefaults.standard.set("local", forKey: "mode"); localURL = nil; startServer() }
    @objc func useCloud() {
        if cloudURL == nil { changeServer(); if cloudURL == nil { return } }
        UserDefaults.standard.set("cloud", forKey: "mode"); localURL = nil; startServer()
    }
    @objc func restartAgents() { guard isLocal else { return }; localURL = nil; startServer() }
    func toggleSetting(_ key: String, default def: Bool) {
        var c = readConfig(); c[key] = !((c[key] as? Bool) ?? def); writeConfig(c)
        if isLocal { localURL = nil; startServer() }
    }
    @objc func toggleKeepAwake() { toggleSetting("keepAwake", default: true) }
    @objc func toggleSandbox() { toggleSetting("sandbox", default: true) }
    @objc func openDataFolder() {
        try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(supportDir)
    }
    // Opens Accounts → Phone in the page: sign in to app.agenthuddle.net and pair a phone with a QR code.
    @objc func phoneAccess() {
        guard isLocal else { return }
        webView.evaluateJavaScript("typeof openAccounts === 'function' && openAccounts('phone')", completionHandler: nil)
    }
    @objc func copyPassword() {
        guard let pw = loadSecrets()["password"] else { return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(pw, forType: .string)
    }
    @objc func relaySettings() {
        var c = readConfig()
        let a = NSAlert()
        a.messageText = "Own relay (advanced)"
        a.informativeText = "Most people should use Agent Huddle → Phone Access… instead. This option serves the agents "
            + "through a Cloudflare Tunnel to an address of your own. When you save, the phone password is copied to "
            + "your clipboard: sign in with it on your phone. "
            + "Your Mac has to be awake with Agent Huddle open for the relay to work."
        let box = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 56))
        let host = NSTextField(frame: NSRect(x: 0, y: 32, width: 360, height: 24))
        host.placeholderString = "Relay address, e.g. agenthuddle.example.com"
        host.stringValue = c["relayHost"] as? String ?? ""
        let tok = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        var secrets = loadSecrets()
        tok.placeholderString = secrets["relayToken"] == nil ? "Tunnel token" : "Token saved (paste a new one to replace it)"
        box.addSubview(host); box.addSubview(tok)
        a.accessoryView = box
        a.addButton(withTitle: "Save"); a.addButton(withTitle: "Cancel")
        if secrets["relayToken"] != nil { a.addButton(withTitle: "Turn Off Relay") }
        let r = a.runModal()
        if r == .alertFirstButtonReturn {
            let h = host.stringValue.trimmingCharacters(in: .whitespaces)
            c["relayHost"] = h.isEmpty ? nil : h
            let t = tok.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { secrets["relayToken"] = t; saveSecrets(secrets) }
            writeConfig(c)
            copyPassword()
        } else if r == .alertThirdButtonReturn {
            secrets.removeValue(forKey: "relayToken"); saveSecrets(secrets)
        } else { return }
        if isLocal { localURL = nil; startServer() }
    }
    @objc func openRelay() {
        if let h = readConfig()["relayHost"] as? String, let u = URL(string: "https://\(h)/") { NSWorkspace.shared.open(u) }
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        let c = readConfig()
        switch item.action {
        case #selector(useLocal): item.state = isLocal ? .on : .off
        case #selector(useCloud): item.state = isLocal ? .off : .on
        case #selector(toggleKeepAwake): item.state = ((c["keepAwake"] as? Bool) ?? true) ? .on : .off; return isLocal
        case #selector(toggleSandbox): item.state = ((c["sandbox"] as? Bool) ?? true) ? .on : .off; return isLocal
        case #selector(restartAgents), #selector(relaySettings), #selector(copyPassword), #selector(phoneAccess): return isLocal
        case #selector(openRelay): return isLocal && c["relayHost"] != nil && loadSecrets()["relayToken"] != nil
        case #selector(changeServer): return !isLocal
        default: break
        }
        return true
    }
    @objc func goHome() { webView.load(URLRequest(url: serverURL)) }
    @objc func zoomIn() { webView.pageZoom = min(webView.pageZoom + 0.1, 2.0) }
    @objc func zoomOut() { webView.pageZoom = max(webView.pageZoom - 0.1, 0.6) }
    @objc func zoomReset() { webView.pageZoom = 1.0 }
    @objc func openInBrowser() { NSWorkspace.shared.open(webView.url ?? serverURL) }
    @objc func changeServer() {
        let a = NSAlert()
        a.messageText = "Cloud address"
        a.informativeText = "Only if you also run Agent Huddle on Cloudflare: the web address of your Agent Huddle Worker."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = cloudURL?.absoluteString ?? "https://"
        field.placeholderString = "https://agenthuddle.example.workers.dev"
        a.accessoryView = field
        a.addButton(withTitle: "Save"); a.addButton(withTitle: "Cancel")
        if a.runModal() == .alertFirstButtonReturn, let u = URL(string: field.stringValue), u.scheme?.hasPrefix("http") == true {
            UserDefaults.standard.set(u.absoluteString, forKey: "serverURL")
            if !isLocal, let u = cloudURL { webView.load(URLRequest(url: u)) }
        }
    }

    func buildMenu() {
        let main = NSMenu()
        func add(_ title: String, _ items: [NSMenuItem]) {
            let item = NSMenuItem(); let menu = NSMenu(title: title)
            for i in items { menu.addItem(i) }; item.submenu = menu; main.addItem(item)
        }
        func mi(_ t: String, _ a: Selector?, _ k: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: t, action: a, keyEquivalent: k); i.keyEquivalentModifierMask = mods; return i
        }
        let updateItem = mi("Check for Updates…", #selector(SPUStandardUpdaterController.checkForUpdates(_:)), "")
        updateItem.target = updater
        add("Agent Huddle", [
            mi("About Agent Huddle", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
            updateItem,
            .separator(),
            mi("Run Agents on This Mac", #selector(useLocal), ""),
            mi("Use the Cloud Version", #selector(useCloud), ""),
            mi("Cloud Address…", #selector(changeServer), ""),
            .separator(),
            mi("Restart Agents", #selector(restartAgents), "r", [.command, .shift]),
            mi("Sign In Again", #selector(signInAgain), ""),
            mi("Keep Mac Awake While Plugged In", #selector(toggleKeepAwake), ""),
            mi("Contain Agents (Sandbox)", #selector(toggleSandbox), ""),
            .separator(),
            mi("Phone Access…", #selector(phoneAccess), ","),
            mi("Own Relay (Advanced)…", #selector(relaySettings), ""),
            mi("Open Agent Huddle Folder", #selector(openDataFolder), ""),
            .separator(),
            mi("Hide Agent Huddle", #selector(NSApplication.hide(_:)), "h"),
            mi("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            mi("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
            .separator(),
            mi("Quit Agent Huddle", #selector(NSApplication.terminate(_:)), "q"),
        ])
        // Standard Edit menu so ⌘C / ⌘V / ⌘A / ⌘Z work inside the page.
        add("Edit", [
            mi("Undo", Selector(("undo:")), "z"),
            mi("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            mi("Cut", #selector(NSText.cut(_:)), "x"),
            mi("Copy", #selector(NSText.copy(_:)), "c"),
            mi("Paste", #selector(NSText.paste(_:)), "v"),
            mi("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        add("View", [
            mi("Reload", #selector(reload), "r"),
            mi("Open in Browser", #selector(openInBrowser), "o", [.command, .shift]),
            .separator(),
            mi("Zoom In", #selector(zoomIn), "+"),
            mi("Zoom Out", #selector(zoomOut), "-"),
            mi("Actual Size", #selector(zoomReset), "0"),
            .separator(),
            mi("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        add("Window", [
            mi("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            mi("Zoom", #selector(NSWindow.performZoom(_:)), ""),
            mi("Close", #selector(NSWindow.performClose(_:)), "w"),
        ])
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
