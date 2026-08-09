# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## Project and team

- Source repository: [greatzhu-cyber/fuck-ddl](https://github.com/greatzhu-cyber/fuck-ddl)
- Committer and reviewer: [@greatzhu-cyber](https://github.com/greatzhu-cyber)
- Signing approver: [@greatzhu-cyber](https://github.com/greatzhu-cyber)

Changes from contributors who do not have direct commit access must be reviewed before merge. Every signing request requires explicit manual approval by the signing approver.

## Signed artifact scope

The project signs only binaries built from source and build scripts in this repository:

- `Fuck DDL_<version>_x64-setup.exe`
- `fuck-ddl.exe`
- `fuck-ddl-edge-host.exe`

The product name must be `Fuck DDL`, and all product-version metadata produced by one release must use the same release version. Third-party upstream binaries are not presented as binaries built or maintained by this project.

## Verifiable build and release process

For signed releases:

1. A release is built from a versioned Git commit in this repository by the configured GitHub Actions and SignPath workflow.
2. The workflow runs the repository quality gates before producing release artifacts.
3. SignPath receives only artifacts produced by that controlled workflow; arbitrary local binaries are not eligible for signing.
4. The signing approver manually reviews and approves every signing request.
5. The release records the source commit, artifact SHA256 values and signature verification result.

The `v0.3.0-unsigned-preview` bootstrap release is an explicit one-time exception created for the SignPath Foundation application. It was built locally from tagged commit `68881a9` after the same local quality gates and the matching GitHub CI run passed. It is intentionally unsigned, is not eligible for signing or promotion in place, and must not be represented as a signed stable release. After approval, stable Windows releases must pass the controlled SignPath workflow and Authenticode verification before publication.

## Privacy and security

See the project [Privacy Policy](../PRIVACY.md) and [Security Policy](../SECURITY.md).
