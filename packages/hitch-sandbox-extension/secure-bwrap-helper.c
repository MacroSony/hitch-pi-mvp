#define _GNU_SOURCE

/*
 * Phase 0 Bubblewrap handoff helper.
 *
 * Provenance: bounded adaptation of ../hitch-hub/src/v2/sandbox/native/
 * secure-bwrap-launcher.c. The helper reopens every source with openat2,
 * revalidates its exact identity, seals the reviewed worker into a memfd,
 * and gives Bubblewrap descriptors rather than host pathnames.
 */

#include <fcntl.h>
#include <inttypes.h>
#include <linux/memfd.h>
#include <linux/openat2.h>
#include <openssl/evp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define FRAME_MAGIC "HITCHP0B1\n"
#define FRAME_MAGIC_LENGTH 10
#define MAX_FRAME_BYTES 65536
#define MAX_SOURCES 6
#define TARGET_FD_BASE 100

static void die(void) {
  fputs("secure sandbox launch rejected\n", stderr);
  _exit(125);
}

static void read_exact(int fd, void *output, size_t length) {
  uint8_t *cursor = output;
  while (length > 0) {
    ssize_t count = read(fd, cursor, length);
    if (count <= 0) die();
    cursor += (size_t)count;
    length -= (size_t)count;
  }
}

static void write_exact(int fd, const void *input, size_t length) {
  const uint8_t *cursor = input;
  while (length > 0) {
    ssize_t count = write(fd, cursor, length);
    if (count <= 0) die();
    cursor += (size_t)count;
    length -= (size_t)count;
  }
}

static uint8_t hex_nibble(char value) {
  if (value >= '0' && value <= '9') return (uint8_t)(value - '0');
  if (value >= 'a' && value <= 'f') return (uint8_t)(value - 'a' + 10);
  die();
  return 0;
}

static char *decode_hex(const char *hex, int require_absolute) {
  size_t length = strlen(hex);
  if (length < 2 || length > 8192 || (length % 2) != 0) die();
  char *output = calloc(length / 2 + 1, 1);
  if (output == NULL) die();
  for (size_t index = 0; index < length; index += 2) {
    uint8_t value =
        (uint8_t)((hex_nibble(hex[index]) << 4) | hex_nibble(hex[index + 1]));
    if (value == 0) die();
    output[index / 2] = (char)value;
  }
  if (require_absolute && output[0] != '/') die();
  return output;
}

static void decode_digest(const char *hex, uint8_t output[32]) {
  if (strlen(hex) != 64) die();
  for (size_t index = 0; index < 32; index++) {
    output[index] = (uint8_t)((hex_nibble(hex[index * 2]) << 4) |
                              hex_nibble(hex[index * 2 + 1]));
  }
}

static int sealed_copy(int source_fd, const char *expected_hex,
                       uint64_t expected_size) {
  uint8_t expected_digest[32];
  decode_digest(expected_hex, expected_digest);
  int output_fd = (int)syscall(SYS_memfd_create, "hitch-p0-worker",
                               MFD_CLOEXEC | MFD_ALLOW_SEALING);
  if (output_fd < 0) die();
  EVP_MD_CTX *digest = EVP_MD_CTX_new();
  if (digest == NULL || EVP_DigestInit_ex(digest, EVP_sha256(), NULL) != 1)
    die();
  uint8_t buffer[65536];
  uint64_t total = 0;
  for (;;) {
    ssize_t count = read(source_fd, buffer, sizeof(buffer));
    if (count < 0) die();
    if (count == 0) break;
    total += (uint64_t)count;
    if (total > expected_size ||
        EVP_DigestUpdate(digest, buffer, (size_t)count) != 1)
      die();
    write_exact(output_fd, buffer, (size_t)count);
  }
  uint8_t actual_digest[EVP_MAX_MD_SIZE];
  unsigned actual_length = 0;
  if (total != expected_size ||
      EVP_DigestFinal_ex(digest, actual_digest, &actual_length) != 1 ||
      actual_length != 32 || memcmp(actual_digest, expected_digest, 32) != 0)
    die();
  EVP_MD_CTX_free(digest);
  if (lseek(output_fd, 0, SEEK_SET) != 0 || fchmod(output_fd, 0444) != 0 ||
      fcntl(output_fd, F_ADD_SEALS,
            F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL) != 0)
    die();
  return output_fd;
}

static void verify_digest(int source_fd, const char *expected_hex,
                          uint64_t expected_size) {
  uint8_t expected_digest[32];
  decode_digest(expected_hex, expected_digest);
  EVP_MD_CTX *digest = EVP_MD_CTX_new();
  if (digest == NULL || EVP_DigestInit_ex(digest, EVP_sha256(), NULL) != 1)
    die();
  uint8_t buffer[65536];
  uint64_t total = 0;
  for (;;) {
    ssize_t count = pread(source_fd, buffer, sizeof(buffer), (off_t)total);
    if (count < 0) die();
    if (count == 0) break;
    total += (uint64_t)count;
    if (total > expected_size ||
        EVP_DigestUpdate(digest, buffer, (size_t)count) != 1)
      die();
  }
  uint8_t actual_digest[EVP_MAX_MD_SIZE];
  unsigned actual_length = 0;
  if (total != expected_size ||
      EVP_DigestFinal_ex(digest, actual_digest, &actual_length) != 1 ||
      actual_length != 32 || memcmp(actual_digest, expected_digest, 32) != 0)
    die();
  EVP_MD_CTX_free(digest);
}

static int strict_source_path(const char *path) {
  size_t length = strlen(path);
  if (length < 2 || length > 4096 || path[0] != '/' ||
      path[length - 1] == '/' || strstr(path, "//") != NULL ||
      strstr(path, "/./") != NULL || strstr(path, "/../") != NULL)
    return 0;
  if (length >= 2 && strcmp(path + length - 2, "/.") == 0) return 0;
  if (length >= 3 && strcmp(path + length - 3, "/..") == 0) return 0;
  return 1;
}

static int expected_source(unsigned index, unsigned count, char kind,
                           char access, const char *destination) {
  if (index == 0)
    return kind == 'd' && access == 'w' && strcmp(destination, "/workspace") == 0;
  if (index == 1)
    return kind == 'd' && access == 'r' && strcmp(destination, "/inbox") == 0;
  if (index == 2)
    return kind == 'f' && access == 'r' &&
           strcmp(destination, "/hitch-runtime/worker.mjs") == 0;
  if (index == 3)
    return kind == 'f' && access == 'r' &&
           strcmp(destination, "/hitch-runtime/publish-copy") == 0;
  if (index == 4)
    return kind == 'd' && access == 'r' && strcmp(destination, "/usr") == 0;
  return count == 6 && index == 5 && kind == 'd' && access == 'w' &&
         strcmp(destination, "/publish") == 0;
}

static int strict_relative_path(const char *path) {
  size_t length = strlen(path);
  if (length < 1 || length > 4096 || path[0] == '/' || path[length - 1] == '/' ||
      strstr(path, "//") != NULL)
    return 0;
  char *copy = strdup(path);
  if (copy == NULL) return 0;
  char *save = NULL;
  char *part = strtok_r(copy, "/", &save);
  unsigned count = 0;
  while (part != NULL) {
    if (part[0] == '\0' || strcmp(part, ".") == 0 || strcmp(part, "..") == 0) {
      free(copy);
      return 0;
    }
    count++;
    part = strtok_r(NULL, "/", &save);
  }
  free(copy);
  return count > 0;
}

static int strict_artifact_id(const char *value) {
  if (strlen(value) != 32) return 0;
  for (size_t index = 0; index < 32; index++) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f')))
      return 0;
  }
  return 1;
}

static void publish_die(int target_fd, int publication_fd,
                        const char *temporary_name) {
  if (target_fd >= 0) close(target_fd);
  if (publication_fd >= 0 && temporary_name != NULL)
    unlinkat(publication_fd, temporary_name, 0);
  die();
}

static int publish_copy(const char *source_path, const char *artifact_id) {
  if (!strict_relative_path(source_path) || !strict_artifact_id(artifact_id))
    die();
  int workspace_fd = open("/workspace", O_PATH | O_DIRECTORY | O_CLOEXEC);
  int publication_fd = open("/publish", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (workspace_fd < 0 || publication_fd < 0) die();
  struct open_how source_how = {
      .flags = O_RDONLY | O_CLOEXEC,
      .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
                 RESOLVE_NO_MAGICLINKS,
  };
  int source_fd = (int)syscall(SYS_openat2, workspace_fd, source_path,
                               &source_how, sizeof(source_how));
  if (source_fd < 0) die();
  struct stat before;
  if (fstat(source_fd, &before) != 0 || !S_ISREG(before.st_mode) ||
      before.st_nlink != 1 || before.st_size < 0 ||
      before.st_size > 50 * 1024 * 1024)
    die();
  char temporary_name[48];
  char final_name[48];
  if (snprintf(temporary_name, sizeof(temporary_name), "%s.tmp", artifact_id) <= 0 ||
      snprintf(final_name, sizeof(final_name), "%s.blob", artifact_id) <= 0)
    die();
  int target_fd = openat(publication_fd, temporary_name,
                         O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                         0400);
  if (target_fd < 0) die();
  EVP_MD_CTX *digest = EVP_MD_CTX_new();
  if (digest == NULL || EVP_DigestInit_ex(digest, EVP_sha256(), NULL) != 1)
    publish_die(target_fd, publication_fd, temporary_name);
  uint8_t buffer[65536];
  off_t position = 0;
  while (position < before.st_size) {
    size_t wanted = (size_t)(before.st_size - position);
    if (wanted > sizeof(buffer)) wanted = sizeof(buffer);
    ssize_t count = pread(source_fd, buffer, wanted, position);
    if (count <= 0 || EVP_DigestUpdate(digest, buffer, (size_t)count) != 1)
      publish_die(target_fd, publication_fd, temporary_name);
    size_t written = 0;
    while (written < (size_t)count) {
      ssize_t result = write(target_fd, buffer + written, (size_t)count - written);
      if (result <= 0) publish_die(target_fd, publication_fd, temporary_name);
      written += (size_t)result;
    }
    position += count;
  }
  struct stat after;
  if (fstat(source_fd, &after) != 0 || before.st_dev != after.st_dev ||
      before.st_ino != after.st_ino || before.st_mode != after.st_mode ||
      before.st_nlink != after.st_nlink || before.st_size != after.st_size ||
      before.st_mtim.tv_sec != after.st_mtim.tv_sec ||
      before.st_mtim.tv_nsec != after.st_mtim.tv_nsec ||
      before.st_ctim.tv_sec != after.st_ctim.tv_sec ||
      before.st_ctim.tv_nsec != after.st_ctim.tv_nsec)
    publish_die(target_fd, publication_fd, temporary_name);
  uint8_t actual_digest[EVP_MAX_MD_SIZE];
  unsigned digest_length = 0;
  if (EVP_DigestFinal_ex(digest, actual_digest, &digest_length) != 1 ||
      digest_length != 32 || fsync(target_fd) != 0 || close(target_fd) != 0)
    publish_die(-1, publication_fd, temporary_name);
  target_fd = -1;
  EVP_MD_CTX_free(digest);
  if (renameat(publication_fd, temporary_name, publication_fd, final_name) != 0)
    publish_die(-1, publication_fd, temporary_name);
  if (fsync(publication_fd) != 0) {
    unlinkat(publication_fd, final_name, 0);
    fsync(publication_fd);
    die();
  }
  char digest_hex[65];
  for (size_t index = 0; index < 32; index++)
    snprintf(digest_hex + index * 2, 3, "%02x", actual_digest[index]);
  digest_hex[64] = '\0';
  printf("{\"artifactId\":\"%s\",\"bytes\":%" PRIu64
         ",\"sha256\":\"%s\"}\n",
         artifact_id, (uint64_t)before.st_size, digest_hex);
  close(source_fd);
  close(workspace_fd);
  close(publication_fd);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 4 && strcmp(argv[1], "--publish-copy") == 0)
    return publish_copy(argv[2], argv[3]);
  if (argc != 1) die();
  uint8_t header[FRAME_MAGIC_LENGTH + 4];
  read_exact(STDIN_FILENO, header, sizeof(header));
  if (memcmp(header, FRAME_MAGIC, FRAME_MAGIC_LENGTH) != 0) die();
  uint32_t payload_length = ((uint32_t)header[10] << 24) |
                            ((uint32_t)header[11] << 16) |
                            ((uint32_t)header[12] << 8) | header[13];
  if (payload_length == 0 || payload_length > MAX_FRAME_BYTES) die();
  char *payload = calloc((size_t)payload_length + 1, 1);
  if (payload == NULL) die();
  read_exact(STDIN_FILENO, payload, payload_length);

  char *save = NULL;
  char *line = strtok_r(payload, "\n", &save);
  char nonce[65] = {0};
  unsigned count = 0;
  uint64_t temporary_bytes = 0;
  char extra = 0;
  if (line == NULL ||
      sscanf(line, "%64[a-f0-9] %u %" SCNu64 " %c", nonce, &count,
             &temporary_bytes, &extra) != 3 ||
      strlen(nonce) != 64 || (count != 5 && count != 6) ||
      temporary_bytes < 4096 || temporary_bytes > 67108864)
    die();

  int root_fd = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (root_fd < 0) die();
  for (unsigned index = 0; index < count; index++) {
    line = strtok_r(NULL, "\n", &save);
    if (line == NULL) die();
    char kind = 0;
    char access = 0;
    uint64_t expected_device = 0;
    uint64_t expected_inode = 0;
    unsigned expected_mode = 0;
    uint64_t expected_links = 0;
    unsigned expected_uid = 0;
    unsigned expected_gid = 0;
    uint64_t expected_size = 0;
    char expected_digest[65] = {0};
    char destination_hex[8193] = {0};
    char source_hex[8193] = {0};
    if (sscanf(line,
               "%c %c %8192s %" SCNu64 " %" SCNu64 " %u %" SCNu64
               " %u %u %" SCNu64 " %64s %8192s %c",
               &kind, &access, destination_hex, &expected_device,
               &expected_inode, &expected_mode, &expected_links, &expected_uid,
               &expected_gid, &expected_size, expected_digest, source_hex,
               &extra) != 12)
      die();
    char *destination = decode_hex(destination_hex, 1);
    char *source = decode_hex(source_hex, 1);
    if (!expected_source(index, count, kind, access, destination) ||
        !strict_source_path(source))
      die();
    free(destination);

    struct open_how how = {
        .flags = kind == 'd' ? O_PATH | O_DIRECTORY | O_CLOEXEC
                             : O_RDONLY | O_CLOEXEC,
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
                   RESOLVE_NO_MAGICLINKS,
    };
    int source_fd =
        (int)syscall(SYS_openat2, root_fd, source + 1, &how, sizeof(how));
    free(source);
    if (source_fd < 0) die();
    struct stat value;
    if (fstat(source_fd, &value) != 0 ||
        (uint64_t)value.st_dev != expected_device ||
        (uint64_t)value.st_ino != expected_inode ||
        (unsigned)value.st_mode != expected_mode ||
        (uint64_t)value.st_nlink != expected_links ||
        (unsigned)value.st_uid != expected_uid ||
        (unsigned)value.st_gid != expected_gid ||
        (uint64_t)value.st_size != expected_size ||
        (kind == 'd' ? !S_ISDIR(value.st_mode) : !S_ISREG(value.st_mode)))
      die();

    int mount_fd = source_fd;
    if (kind == 'f') {
      if (expected_links != 1 || expected_uid != (unsigned)getuid() ||
          (expected_mode & 0222) != 0 || strcmp(expected_digest, "-") == 0)
        die();
      if (index == 2) {
        mount_fd = sealed_copy(source_fd, expected_digest, expected_size);
        close(source_fd);
      } else {
        verify_digest(source_fd, expected_digest, expected_size);
      }
    } else if (strcmp(expected_digest, "-") != 0) {
      die();
    }
    int target = TARGET_FD_BASE + (int)index;
    if (mount_fd != target) {
      if (dup2(mount_fd, target) != target) die();
      close(mount_fd);
    }
    if (fcntl(target, F_SETFD, 0) != 0) die();
  }
  if (strtok_r(NULL, "\n", &save) != NULL) die();
  close(root_fd);
  free(payload);

  char acknowledgement[96];
  int acknowledgement_length =
      snprintf(acknowledgement, sizeof(acknowledgement),
               "HITCH_P0_HANDOFF %s %ld\n", nonce, (long)getpid());
  if (acknowledgement_length <= 0 ||
      (size_t)acknowledgement_length >= sizeof(acknowledgement))
    die();
  write_exact(STDOUT_FILENO, acknowledgement,
              (size_t)acknowledgement_length);
  uint8_t continue_byte = 0;
  read_exact(STDIN_FILENO, &continue_byte, 1);
  if (continue_byte != 0x47 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0)
    die();

  char temporary_size[32];
  if (snprintf(temporary_size, sizeof(temporary_size), "%" PRIu64,
               temporary_bytes) <= 0)
    die();
  char *arguments[96];
  size_t argument = 0;
#define ARG(value) arguments[argument++] = (char *)(value)
  ARG("/usr/bin/bwrap");
  ARG("--die-with-parent");
  ARG("--new-session");
  ARG("--unshare-user");
  ARG("--disable-userns");
  ARG("--unshare-pid");
  ARG("--unshare-ipc");
  ARG("--unshare-uts");
  ARG("--unshare-cgroup-try");
  ARG("--unshare-net");
  ARG("--hostname");
  ARG("hitch-p0-worker");
  ARG("--clearenv");
  ARG("--setenv");
  ARG("PATH");
  ARG("/usr/bin:/bin");
  ARG("--setenv");
  ARG("HOME");
  ARG("/tmp");
  ARG("--setenv");
  ARG("TMPDIR");
  ARG("/tmp");
  ARG("--proc");
  ARG("/proc");
  ARG("--dev");
  ARG("/dev");
  ARG("--size");
  ARG(temporary_size);
  ARG("--tmpfs");
  ARG("/tmp");
  ARG("--dir");
  ARG("/run");
  ARG("--dir");
  ARG("/workspace");
  ARG("--dir");
  ARG("/inbox");
  ARG("--dir");
  ARG("/hitch-runtime");
  ARG("--ro-bind-fd");
  ARG("104");
  ARG("/usr");
  ARG("--symlink");
  ARG("usr/bin");
  ARG("/bin");
  ARG("--symlink");
  ARG("usr/lib");
  ARG("/lib");
  ARG("--symlink");
  ARG("usr/lib64");
  ARG("/lib64");
  ARG("--bind-fd");
  ARG("100");
  ARG("/workspace");
  ARG("--ro-bind-fd");
  ARG("101");
  ARG("/inbox");
  ARG("--perms");
  ARG("0444");
  ARG("--ro-bind-data");
  ARG("102");
  ARG("/hitch-runtime/worker.mjs");
  ARG("--ro-bind-fd");
  ARG("103");
  ARG("/hitch-runtime/publish-copy");
  if (count == 6) {
    ARG("--dir");
    ARG("/publish");
    ARG("--bind-fd");
    ARG("105");
    ARG("/publish");
  }
  ARG("--remount-ro");
  ARG("/proc");
  ARG("--remount-ro");
  ARG("/dev");
  ARG("--remount-ro");
  ARG("/");
  ARG("--chdir");
  ARG("/workspace");
  ARG("--");
  ARG("/usr/bin/node");
  ARG("/hitch-runtime/worker.mjs");
  arguments[argument] = NULL;
  execv(arguments[0], arguments);
  die();
}
