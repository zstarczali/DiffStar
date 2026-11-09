DiffStar Installation Guide
===========================

Version 0.2.1
-------------
Folder comparison has three views (details tree, small icons, large icons
with image previews), and a duplicate finder looks for files with the same
content in one or two folders. See whatsnew.txt for the release history.

The main-window Donate button appears after 10 minutes of foreground
use. The timer pauses while the window is unfocused or hidden and
resets each time DiffStar starts. You can also donate from the About
dialog at any time.

Download
--------
On the GitHub Actions page for a successful "Build installers" run,
download the ZIP for your platform from Artifacts and extract it.

Windows x64 and ARM64
---------------------
1. Open Settings > System > About and check System type.
2. For an x64 processor, choose the NSIS .exe from the
   DiffStar-x86_64-pc-windows-msvc artifact. For an ARM processor, choose
   the .exe from DiffStar-aarch64-pc-windows-msvc.
3. Run the DiffStar .exe installer. If the WebView2 Runtime is missing,
   the installer downloads it, which requires an internet connection.
   SmartScreen may warn about the unsigned installer. If you have
   verified the download source, select "More info" and then "Run anyway"
   if Windows offers that option.
4. Open DiffStar from the Start menu.

macOS Apple Silicon (ARM64) and Intel (x64)
------------------------------------------
1. Open Apple menu > About This Mac and check the chip or processor.
   For an Apple M-series chip, choose the .dmg from
   DiffStar-aarch64-apple-darwin. For an Intel processor, choose the .dmg
   from DiffStar-x86_64-apple-darwin.
2. Open the .dmg, drag DiffStar.app into Applications, and eject the disk
   image.
3. Open DiffStar from Applications. If Gatekeeper blocks the app because
   the developer cannot be verified, check the download source. After
   the first launch attempt, open System Settings > Privacy & Security,
   choose "Open Anyway" if available, and confirm.
   Apple guide: https://support.apple.com/en-ie/102445
4. If macOS says that "DiffStar is damaged and can't be opened", or
   "Open Anyway" does not appear, remove the quarantine flag. The app is
   not signed by Apple, so macOS blocks it. Run this in Terminal after
   copying the app to Applications:

     xattr -dr com.apple.quarantine /Applications/DiffStar.app

   If it still does not open, clear all extended attributes:

     xattr -cr /Applications/DiffStar.app

   Repeat this after installing a new version, including one installed by
   the self-update.

Linux x64
---------
Run "uname -m" and confirm that it reports x86_64. The
DiffStar-x86_64-unknown-linux-gnu artifact contains three formats.
Run the commands from the download folder and replace the example
filenames with the actual filenames.

Debian or Ubuntu (.deb)
  sudo apt update
  sudo apt install ./DiffStar_amd64.deb

Fedora or another DNF-based distribution (.rpm)
  sudo dnf install ./DiffStar.x86_64.rpm

AppImage
  chmod +x ./DiffStar_amd64.AppImage
  ./DiffStar_amd64.AppImage

  If you get a FUSE error, install your distribution's FUSE 2
  compatibility package (libfuse2 on Ubuntu 22.04 or libfuse2t64 on
  Ubuntu 24.04).

Command line and git difftool
-----------------------------
  DiffStar <left> <right>                 compare two files or two folders

A running DiffStar opens the pair in a new tab. To use DiffStar as the
git difftool, open Settings > Git and click "Set up now", or run:

  git config --global diff.tool diffstar
  git config --global difftool.diffstar.cmd "\"<path to DiffStar>\" \"$LOCAL\" \"$REMOTE\""
  git config --global difftool.prompt false
