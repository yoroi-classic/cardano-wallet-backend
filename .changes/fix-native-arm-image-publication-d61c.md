### Fixed

- Docker smoke tests use a native HTTP client so ARM64 image publication can check the running service without QEMU consuming the client request deadline.

### Added

- Pull request CI builds, smoke tests, and scans the ARM64 Docker image using the same emulation as publication.
