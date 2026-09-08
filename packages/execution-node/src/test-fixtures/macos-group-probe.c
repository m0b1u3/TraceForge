#include <sys/types.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <sys/wait.h>
int main(void) {
  pid_t child = fork();
  if (child < 0) return 2;
  if (child == 0) {
    errno = 0; int session_result = setsid(); int session_error = errno;
    errno = 0; int group_result = setpgid(0, 0); int group_error = errno;
    printf("{\"setsid\":%d,\"setsidError\":%d,\"setpgid\":%d,\"setpgidError\":%d}\n", session_result, session_error, group_result, group_error);
    return 0;
  }
  int status = 0;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) return 3;
  return WEXITSTATUS(status);
}
