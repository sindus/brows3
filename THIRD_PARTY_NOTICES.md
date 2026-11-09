# Third-party notices

## FFmpeg

Brows3 ships an unmodified FFmpeg executable (`brows3-ffmpeg`) next to the
application. It runs as a separate program, only to build image and video
thumbnails. FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg
project. Website and source code: <https://ffmpeg.org>.

| Platform | Build | Version | License |
|---|---|---|---|
| Linux x64 / ARM64, Windows x64 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), `lgpl` variant, release `autobuild-2026-10-31-12-59` | 9.0.2 | LGPL v3 or later |
| macOS Apple Silicon | [ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de) | 9.0.2 | GPL v3 or later (built with `--enable-gpl --enable-version3`) |
| macOS Intel | [evermeet.cx](https://evermeet.cx/ffmpeg/) | 9.0.2 | GPL v3 or later (built with `--enable-gpl --enable-version3`) |

Each build provider publishes the build configuration and the sources of FFmpeg
and of the libraries it links. The exact download URLs and SHA-256 checksums are
in `.github/workflows/release.yml`.

The license texts are available at:

- LGPL v3: <https://www.gnu.org/licenses/lgpl-3.0.html>
- GPL v3: <https://www.gnu.org/licenses/gpl-3.0.html>

To get the corresponding source code of a bundled FFmpeg binary, use the links
above or open an issue on this repository.
