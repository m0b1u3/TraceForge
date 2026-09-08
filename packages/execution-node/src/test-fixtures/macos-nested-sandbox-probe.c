#include <sandbox.h>
#include <errno.h>
#include <stdio.h>

int main(void) {
  char *message = NULL;
  int result = sandbox_init("(version 1)(allow default)", 0, &message);
  int error = errno;
  printf("{\"result\":%d,\"error\":%d}\n", result, result ? error : 0);
  sandbox_free_error(message);
  return 0;
}
