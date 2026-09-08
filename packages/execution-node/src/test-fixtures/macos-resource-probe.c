/* Bounded characterization fixture, never a production launcher. */
#include <sys/resource.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <errno.h>

int main(void) {
  const rlim_t limit = 8 * 1024 * 1024;
  const size_t allocation = 32 * 1024 * 1024;
  struct rlimit requested = { limit, limit };
  if (setrlimit(RLIMIT_RSS, &requested) != 0) {
    printf("{\"setSucceeded\":false,\"error\":%d}\n", errno);
    return 0;
  }
  volatile unsigned char *bytes = malloc(allocation);
  if (!bytes) return 3;
  for (size_t offset = 0; offset < allocation; offset += 4096) bytes[offset] = 1;
  struct rusage usage;
  if (getrusage(RUSAGE_SELF, &usage) != 0) return 4;
  printf("{\"setSucceeded\":true,\"declaredBytes\":%llu,\"residentBytes\":%ld}\n", (unsigned long long)limit, usage.ru_maxrss);
  free((void *)bytes);
  return 0;
}
