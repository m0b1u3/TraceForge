/* Read-only sampler. Never signals processes or treats PID absence as cleanup.
 * argv: pid expected-start-seconds expected-start-microseconds
 * Expected birth 0/0 is discovery only; launch ownership must come from caller. */
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <unistd.h>
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

static int number(const char *value, uint64_t *out) {
  if (!value || !*value) return 0;
  for (const char *p = value; *p; ++p) if (*p < '0' || *p > '9') return 0;
  errno = 0; char *end = NULL; *out = strtoull(value, &end, 10);
  return !errno && end && !*end;
}
static int metadata(pid_t pid, struct proc_bsdinfo *info) {
  memset(info, 0, sizeof(*info));
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info)) == sizeof(*info)
    && info->pbi_pid == (uint32_t)pid && info->pbi_uid == getuid();
}
int main(int argc, char **argv) {
  uint64_t rawpid, sec, usec;
  if (argc != 4 || !number(argv[1], &rawpid) || rawpid <= 1 || rawpid > INT_MAX
      || !number(argv[2], &sec) || !number(argv[3], &usec) || usec >= 1000000) return 2;
  pid_t pid = (pid_t)rawpid;
  struct proc_bsdinfo before, after;
  struct rusage_info_v2 usage; memset(&usage, 0, sizeof(usage));
  if (!metadata(pid, &before)) return 3;
  if ((sec || usec) && (sec != before.pbi_start_tvsec || usec != before.pbi_start_tvusec)) return 4;
  if (proc_pid_rusage(pid, RUSAGE_INFO_V2, (rusage_info_t *)&usage) != 0) return 5;
  if (!metadata(pid, &after) || before.pbi_start_tvsec != after.pbi_start_tvsec
      || before.pbi_start_tvusec != after.pbi_start_tvusec) return 6;
  if (usage.ri_user_time > UINT64_MAX - usage.ri_system_time) return 7;
  printf("{\"format\":1,\"pid\":%d,\"parentPid\":%u,\"groupId\":%u,"
    "\"startSeconds\":\"%" PRIu64 "\",\"startMicroseconds\":\"%" PRIu64 "\","
    "\"cpuTimeMs\":%" PRIu64 ",\"residentBytes\":%" PRIu64 ",\"writeBytes\":%" PRIu64 "}\n",
    pid, before.pbi_ppid, before.pbi_pgid, before.pbi_start_tvsec, before.pbi_start_tvusec,
    (usage.ri_user_time + usage.ri_system_time) / 1000000, usage.ri_resident_size, usage.ri_diskio_byteswritten);
  return 0;
}
