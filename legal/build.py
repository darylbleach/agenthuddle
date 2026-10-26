# Turns legal/*.md into public/terms.html and public/privacy.html (run after editing the .md files).
import markdown, pathlib, html
root = pathlib.Path(__file__).resolve().parent
page = """<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><style>
:root{{--bg:#f6f5f2;--text:#1f1e1c;--muted:#6b6862;--line:#e2dfd8}}
@media (prefers-color-scheme:dark){{:root{{--bg:#191918;--text:#ecebe8;--muted:#9b988f;--line:#33322f}}}}
body{{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
main{{max-width:760px;margin:0 auto;padding:32px 16px 64px}} h1{{font-size:28px;line-height:1.2}} h2{{font-size:19px;margin-top:32px}}
em{{color:var(--muted)}} a{{color:#2f6fde}} table{{border-collapse:collapse;width:100%;font-size:14px;display:block;overflow-x:auto}}
th,td{{border:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}} code{{font-size:14px}}
</style></head><body><main>{body}</main></body></html>"""
for name in ["terms", "privacy"]:
    md = (root / f"{name}.md").read_text()
    title = md.splitlines()[0].lstrip("# ").strip()
    body = markdown.markdown(md, extensions=["tables"])
    (root.parent / "public" / f"{name}.html").write_text(page.format(title=html.escape(title), body=body))
    print("wrote", name)
