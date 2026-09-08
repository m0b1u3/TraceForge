/* Local supervisor: target inherits stdio only; fd 3 is host-only telemetry.
 * Host closes fd 4 or sends SIGTERM to request cleanup. Root is not reaped
 * until group cleanup, preventing PID/group-id reuse during supervision. */
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/proc.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>
#include <signal.h>
#include <poll.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <inttypes.h>
#include <string.h>
#include <time.h>

static volatile sig_atomic_t stopping = 0;
static void stop(int signal_number) { (void)signal_number; stopping = 1; }
static uint64_t clock_ms(void) {
  struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t)) _exit(90);
  return (uint64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
int main(int argc, char **argv) {
  if (argc < 3 || strlen(argv[1]) > 65536 || argv[2][0] != '/') return 2;
  if (!strstr(argv[1], "(deny syscall-unix (syscall-number SYS_setsid SYS_setpgid))")) return 3;
  FILE *events = fdopen(3, "w"); if (!events) return 4;
  setvbuf(events, NULL, _IONBF, 0);
  signal(SIGPIPE, SIG_IGN); signal(SIGTERM, stop); signal(SIGINT, stop);
  int gate[2]; if (pipe(gate)) return 5;
  pid_t host = getppid(), root = fork();
  if (root < 0) return 6;
  if (root == 0) {
    close(gate[0]); close(3); close(4);
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGPIPE, SIG_DFL);
    if (setsid() < 0) _exit(101);
    if (write(gate[1], "R", 1) != 1) _exit(102);
    close(gate[1]);
    char **args = calloc((size_t)argc + 2, sizeof(char *)); if (!args) _exit(103);
    args[0] = "/usr/bin/sandbox-exec"; args[1] = "-p"; args[2] = argv[1];
    for (int i = 2; i < argc; ++i) args[i + 1] = argv[i];
    execv(args[0], args); _exit(104);
  }
  close(gate[1]);
  char ready = 0; struct pollfd startup = { gate[0], POLLIN, 0 };
  if (poll(&startup, 1, 2000) != 1 || read(gate[0], &ready, 1) != 1 || ready != 'R') {
    kill(root, SIGKILL); waitpid(root, NULL, 0); close(gate[0]); return 7;
  }
  close(gate[0]);
  fprintf(events, "{\"type\":\"ready\",\"pid\":%d}\n", root);
  uint64_t cleanup_at = 0; int failed = 0;
  for (;;) {
    if (getppid() != host) stopping = 1;
    struct pollfd control = { 4, POLLIN | POLLHUP, 0 };
    if (poll(&control, 1, 0) > 0 && control.revents) stopping = 1;
    siginfo_t info; memset(&info, 0, sizeof(info));
    if (waitid(P_PID, (id_t)root, &info, WEXITED | WNOHANG | WNOWAIT) < 0) { stopping = 1; failed = 1; }
    if (info.si_pid == root) stopping = 1;
    if (stopping) {
      if (!cleanup_at) cleanup_at = clock_ms();
      if (kill(-root, SIGKILL) < 0 && errno != ESRCH) failed = 1;
    }
    pid_t pids[4096]; int bytes = proc_listpids(PROC_PGRP_ONLY, (uint32_t)root, pids, sizeof(pids));
    int scan_valid = bytes >= 0 && bytes < (int)sizeof(pids) && bytes % sizeof(pid_t) == 0;
    if (!scan_valid || (!bytes && info.si_pid != root)) { stopping = 1; failed = 1; }
    int living = 0;
    if (!stopping) fprintf(events, "{\"type\":\"sample\",\"processes\":[");
    int comma = 0;
    for (int i = 0; scan_valid && bytes > 0 && i < bytes / (int)sizeof(pid_t); ++i) {
      if (pids[i] <= 0) continue;
      if (pids[i] == root && info.si_pid == root) continue;
      struct proc_bsdinfo b, after;
      if (proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &b, sizeof(b)) != sizeof(b)) {
        // A process may exit between enumeration and inspection. Only a
        // confirmed disappearance is harmless; denied/unknown reads fail closed.
        if (errno == ESRCH) continue;
        failed = 1; scan_valid = 0; continue;
      }
      if (b.pbi_pgid != (uint32_t)root || b.pbi_uid != getuid()) { failed = 1; scan_valid = 0; continue; }
      if (b.pbi_status == SZOMB) continue;
      ++living;
      if (stopping) continue;
      struct rusage_info_v2 usage;
      if (proc_pid_rusage(pids[i], RUSAGE_INFO_V2, (rusage_info_t *)&usage)) {
        int inspected = proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &after, sizeof(after));
        if ((inspected != sizeof(after) && errno == ESRCH)
          || (inspected == sizeof(after) && after.pbi_status == SZOMB
            && b.pbi_start_tvsec == after.pbi_start_tvsec && b.pbi_start_tvusec == after.pbi_start_tvusec)) continue;
        failed = 1; continue;
      }
      if (proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &after, sizeof(after)) != sizeof(after)) {
        if (errno == ESRCH) continue;
        failed = 1; continue;
      }
      if (after.pbi_pgid != (uint32_t)root || after.pbi_uid != getuid()
        || b.pbi_start_tvsec != after.pbi_start_tvsec || b.pbi_start_tvusec != after.pbi_start_tvusec
        || usage.ri_user_time > UINT64_MAX - usage.ri_system_time) { failed = 1; continue; }
      fprintf(events, "%s{\"identity\":\"%d:%" PRIu64 ":%" PRIu64 "\",\"cpuTimeMs\":%" PRIu64 ",\"residentBytes\":%" PRIu64 ",\"writeBytes\":%" PRIu64 "}",
        comma++ ? "," : "", pids[i], b.pbi_start_tvsec, b.pbi_start_tvusec,
        (usage.ri_user_time + usage.ri_system_time) / 1000000, usage.ri_resident_size, usage.ri_diskio_byteswritten);
    }
    if (!stopping) fprintf(events, "],\"valid\":%s}\n", failed ? "false" : "true");
    if (ferror(events)) { stopping = 1; failed = 1; }
    if (stopping && !living && info.si_pid == root && scan_valid) {
      int status = 0; if (waitpid(root, &status, 0) != root) return 8;
      fprintf(events, "{\"type\":\"terminal\",\"exitCode\":%d,\"signal\":%d}\n",
        WIFEXITED(status) ? WEXITSTATUS(status) : -1, WIFSIGNALED(status) ? WTERMSIG(status) : 0);
      return 0;
    }
    if (failed) stopping = 1;
    if (cleanup_at && clock_ms() - cleanup_at > 3000) { kill(-root, SIGKILL); return 9; }
    usleep(20000);
  }
}
