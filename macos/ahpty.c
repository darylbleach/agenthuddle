// ahpty: runs a command inside a pseudo-terminal and relays its input and output through plain pipes.
// The login console needs this on macOS: the system's `script` refuses to start unless its own input is
// a terminal, and the app talks to it through pipes. build.sh compiles this into the app.
//
//   ahpty /bin/bash -lc 'claude auth login'
//
// The terminal is 1000 columns wide so sign-in links print on one line. Exits with the command's status.
#ifdef __APPLE__
#include <util.h>
#else
#include <pty.h>
#endif
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

static pid_t child = -1;
// The command runs in its own session (forkpty), so pass stop signals on to its whole process group.
static void forward(int sig) { if (child > 0) kill(-child, sig); }

static int write_all(int fd, const char *buf, ssize_t len) {
  ssize_t off = 0;
  while (off < len) {
    ssize_t w = write(fd, buf + off, (size_t)(len - off));
    if (w < 0) { if (errno == EINTR) continue; return -1; }
    off += w;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: ahpty command [args…]\n"); return 2; }
  struct winsize ws = { .ws_row = 50, .ws_col = 1000 };
  int master;
  child = forkpty(&master, NULL, NULL, &ws);
  if (child < 0) { perror("ahpty: forkpty"); return 1; }
  if (child == 0) { execvp(argv[1], argv + 1); perror(argv[1]); _exit(127); }

  signal(SIGTERM, forward); signal(SIGINT, forward); signal(SIGHUP, forward); signal(SIGPIPE, SIG_IGN);
  int in_open = 1;
  char buf[16384];
  for (;;) {
    fd_set r; FD_ZERO(&r); FD_SET(master, &r); if (in_open) FD_SET(0, &r);
    if (select(master + 1, &r, NULL, NULL, NULL) < 0) { if (errno == EINTR) continue; break; }
    if (in_open && FD_ISSET(0, &r)) {
      ssize_t n = read(0, buf, sizeof buf);
      if (n <= 0) in_open = 0;                      // input closed: keep showing output until the command ends
      else if (write_all(master, buf, n) < 0) in_open = 0;
    }
    if (FD_ISSET(master, &r)) {
      ssize_t n = read(master, buf, sizeof buf);
      if (n <= 0) break;                            // the command (and anything holding its terminal) ended
      if (write_all(1, buf, n) < 0) break;
    }
  }
  int st = 0;
  while (waitpid(child, &st, 0) < 0 && errno == EINTR) {}
  if (WIFEXITED(st)) return WEXITSTATUS(st);
  if (WIFSIGNALED(st)) return 128 + WTERMSIG(st);
  return 1;
}
