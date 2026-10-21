#include <sys/types.h>
#include <sys/sysctl.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Read only startup path variables. Never emit command lines or credentials. */
static void json_string(const char *s) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char *end;
  long pid = strtol(argv[1], &end, 10);
  if (*end || pid <= 0 || pid > 2147483647) return 2;
  int mib[] = { CTL_KERN, KERN_PROCARGS2, (int)pid };
  size_t length = 0;
  if (sysctl(mib, 3, NULL, &length, NULL, 0)) return kill((pid_t)pid, 0) && errno == ESRCH ? 3 : 1;
  if (length <= sizeof(int) || length > 4 * 1024 * 1024) return 1;
  char *data = calloc(length + 1, 1);
  if (!data) return 1;
  if (sysctl(mib, 3, data, &length, NULL, 0)) { int status = errno == ESRCH ? 3 : 1; free(data); return status; }
  int count;
  memcpy(&count, data, sizeof(int));
  if (count < 1 || count > (int)length) { free(data); return 1; }
  char *p = data + sizeof(int), *limit = data + length;
  while (p < limit && *p) p++; /* executable path */
  while (p < limit && !*p) p++; /* alignment */
  for (int i = 0; i < count && p < limit; i++) {
    while (p < limit && *p) p++;
    if (p < limit) p++;
  }
  const char *names[] = { "HOME", "XDG_DATA_HOME" };
  char *values[] = { NULL, NULL };
  while (p < limit && *p) {
    char *next = memchr(p, 0, (size_t)(limit - p));
    if (!next) { free(data); return 1; }
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
      size_t n = strlen(names[i]);
      if (!strncmp(p, names[i], n) && p[n] == '=') {
        if (values[i]) { free(data); return 1; }
        values[i] = p + n + 1;
      }
    }
    p = next + 1;
  }
  int first = 1;
  putchar('{');
  for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
    if (!values[i]) continue;
    if (!first) putchar(','); first = 0;
    json_string(names[i]); putchar(':'); json_string(values[i]);
  }
  puts("}");
  free(data);
  return 0;
}
