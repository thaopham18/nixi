# Nixi

Ứng dụng remote all-in-one kiểu MobaXterm cho macOS (Electron + TypeScript + React).

© 2026 Thao Pham · thaopham.cyber@gmail.com · [MIT License](LICENSE)

VNC dùng [noVNC](https://github.com/novnc/noVNC), giấy phép MPL-2.0.

## Chức năng hiện có (Phase 1 + 2)

| Nhóm | Chức năng |
|---|---|
| Session | Cây session có folder, kéo thả để chuyển folder, tìm kiếm, Recent, duplicate/xoá, đổi tên folder. Loại: SSH, Telnet, Local shell, RDP, VNC. Import `~/.ssh/config`, import/export JSON (không kèm mật khẩu). |
| RDP | Chạy ngay trong tab (IronRDP WebAssembly), không cần app ngoài, dùng được trên macOS. Có NLA/CredSSP, độ phân giải tự theo kích thước tab (hoặc cố định), clipboard text, nút Ctrl+Alt+Del / phím Win. Mật khẩu lưu trong database hoặc hỏi khi kết nối. Kiểm tra chứng chỉ server kiểu TOFU. Mỗi session chọn được "Open with": tab Nixi (nhúng, giải mã bằng phần mềm) hoặc client chính chủ Windows App/mstsc (H.264 phần cứng, mượt nhất). |
| VNC | Chạy ngay trong tab (noVNC). Kết nối được macOS Screen Sharing (tài khoản Mac), TightVNC, UltraVNC (MS-Logon II), TigerVNC, x11vnc, wayvnc, QEMU/KVM… Có mật khẩu VNC, VeNCrypt + TLS X509 (kiểm chứng chỉ kiểu TOFU), đi qua một session SSH đã lưu (cho server chỉ nghe localhost), clipboard text 2 chiều (tắt được việc tự gửi clipboard theo từng session), 3 chế độ hiển thị (vừa tab / đúng kích thước / đổi độ phân giải máy xa), chọn Smooth / Balanced / Sharp, View only, Ctrl+Alt+Del, mở bằng app VNC của hệ thống. |
| MobaXterm | Import `MobaXterm.ini` / `.mxtsessions`: session SSH (cả gateway → jump host, key, startup command, màu tab), RDP (cả `DOMAIN\user`), Telnet và VNC (host + port), giữ cấu trúc folder. Macro bị mã hoá thì giải mã bằng master password của MobaXterm (thử nghiệm). Export ra `.mxtsessions` để mở lại bằng MobaXterm. Không import/export mật khẩu. |
| Telnet | Session Telnet (mặc định port 23) cho switch/router: tự đàm phán kiểu terminal và kích thước cửa sổ (NAWS), tuỳ chọn tự đăng nhập (trả lời Username/Password) và lệnh chạy sau khi đăng nhập, bảng mã UTF-8 hoặc Latin-1. Import cả session Telnet từ MobaXterm. |
| SSH | Password / private key (+ passphrase) / ssh-agent, keyboard-interactive, ProxyJump qua session khác, keepalive, startup command. Xác minh host key kiểu TOFU, cảnh báo khi key thay đổi. Hỏi mật khẩu khi chưa lưu. |
| Terminal | Nhiều tab (kéo đổi thứ tự, đổi tên, màu tab, nhân bản bằng nút ⧉ hoặc chuột phải → Duplicate), xterm.js WebGL (tắt được trong Settings nếu GPU của máy gây lỗi hiển thị), truecolor, 3 theme, tìm kiếm trong buffer, link click được, nhấn **R** để reconnect. |
| Split view | Xem nhiều session cùng lúc (SSH, local, RDP lẫn lộn): kéo tab hoặc session từ sidebar thả vào vùng Left/Right/Top/Bottom/Grid; "Split with…", "Tile all tabs" (⇧⌘G), layout cạnh nhau / chồng / lưới, kéo thanh chia để đổi kích thước, phóng to 1 pane (double-click tiêu đề), tách pane ra tab riêng. Session không bị ngắt khi di chuyển. |
| Copy/Paste | Bôi đen = copy, chuột phải = paste, ⌘C/⌘V, cảnh báo paste nhiều dòng, bracketed paste. |
| SFTP | Tab SFTP ở sidebar chỉ hiện khi đang ở tab SSH, tự mở khi SSH kết nối; duyệt, tạo folder, đổi tên, chmod, xoá (đệ quy), upload (kéo thả từ Finder hoặc chọn file), download (cả thư mục), hàng đợi transfer có tiến độ + huỷ, double-click để sửa file bằng editor ngoài và tự upload lại khi lưu, "Follow terminal" (OSC 7). |
| Server stats | Thanh dưới terminal SSH: host, CPU, RAM, disk (hover để xem bảng mọi ổ đĩa), mạng ↓↑, load, uptime, số user (Linux qua /proc, macOS/BSD qua sysctl/vm_stat). Tắt trong Settings. |
| Tunnel | Local (-L), Remote (-R), Dynamic SOCKS5 (-D), vẽ thành sơ đồ máy mình → SSH server → máy đích (ô nhập nằm ngay trong từng khối, có câu "thử kết nối tới… sẽ tới…" và preset Web/MySQL/PostgreSQL…); bật/tắt từng tunnel, tự chạy khi mở app, đếm kết nối, tự reconnect khi rớt. |
| Macro | Ghi macro từ bàn phím, soạn bằng text (`> lệnh`, `>> raw\n`, `wait 500`, `expect regex 5000`), gán phím tắt, chạy trên tab hiện tại hoặc mọi tab đang multi-exec. ⌘J mở danh sách macro ngay tại con trỏ terminal: ↑↓ chọn, ↵ chạy, 1–9 chạy thẳng, gõ để lọc, Esc đóng. |
| Multi-exec | Gõ một lần, gửi tới tất cả terminal (có checkbox loại trừ từng pane, viền vàng báo). |
| Database | Mọi thứ (session, mật khẩu, macro, tunnel, known hosts, settings) nằm trong **một file `nixi.nxdb`** kiểu KeePass: mã hoá AES-256-GCM, khoá dẫn xuất từ master password bằng scrypt; file cũ được giữ thành `.ezdb.bak` mỗi lần lưu. Mở khoá khi khởi động, tuỳ chọn "Remember on this computer" (khoá lưu trong Keychain), menu Database → Lock / Change Master Password / Move / Open. Copy file hoặc để trong iCloud/Dropbox để dùng trên máy khác. Dữ liệu cũ (MacTerm) tự chuyển vào lần đầu. |
| Bảo mật | Renderer sandbox + contextIsolation; mọi kết nối mạng chạy ở main process; một instance mỗi profile để không ghi đè database. |

Phím tắt chính (macOS): ⌘N session mới, ⌘T local, ⌘D / ⇧⌘D split, ⌘W đóng, ⌘R reconnect, ⌘F tìm, ⌘K xoá màn hình, ⌘B sidebar, ⇧⌘F SFTP, ⇧⌘U tunnels, ⇧⌘M macros, ⌘J chọn macro tại con trỏ (đổi phím trong Settings → Macros, nhận mọi tổ hợp — kể cả phím trùng menu như ⌘W, khi đó phím của mày thắng), ⇧⌘I multi-exec, ⌘+/⌘- cỡ chữ.
Trên Windows/Linux các phím này chuyển sang Ctrl+Shift+… để không chiếm Ctrl+R/Ctrl+D của shell.

## Yêu cầu

- **Node.js ≥ 20** (đã dùng 22 và 24) và npm.
- **macOS**: Xcode Command Line Tools (`xcode-select --install`) để build module kéo file SFTP ra Finder (`native/drag-promise.mm`). Không có thì app vẫn chạy, chỉ là kéo file ra ngoài sẽ tải về thư mục tạm trước.
- **Windows**: build được bản `.exe`; không cần công cụ native.
- npm ≥ 11 có thể chặn install script của dependency. Nếu `npm ci` báo vậy:

```bash
npm install-scripts approve electron esbuild ssh2
```

## Chạy khi phát triển

```bash
git clone <repo> && cd <repo>
npm ci
npm run dev
```

Lần chạy đầu app hỏi tạo database (một file mã hoá bằng master password, nằm trong `~/Library/Application Support/Nixi/`). Không có dữ liệu nào đi kèm repo.

Không có SSH server để thử? Chạy server dev đi kèm (user `test` / password `test`, port 2222):

```bash
node scripts/dev-ssh-server.mjs
```

## Kiểm thử

```bash
npx electron scripts/make-icon.mjs   # vẽ lại build/icon.{png,ico,icns} từ build/icon.svg
npm test                      # unit test (parser, macro, SOCKS5, RDCleanPath, MobaXterm)
npm run typecheck
npm run build && node scripts/e2e-smoke.mjs   # e2e: cần dev-ssh-server đang chạy
node scripts/e2e-vnc.mjs                      # VNC: mọi kiểu xác thực với server giả, không cần máy thật
node scripts/e2e-rdp.mjs [host] [port]        # RDP handshake bằng tài khoản giả (mặc định 127.0.0.1:3389)
node scripts/e2e-moba.mjs path/to/MobaXterm.ini  # import/export MobaXterm trong profile tạm
node scripts/e2e-split.mjs                    # split view + xoá folder (cần dev-ssh-server)
node scripts/e2e-auth.mjs                     # hỏi mật khẩu, lưu mật khẩu, kích thước terminal
                                              # (chạy dev-ssh-server với --auth-delay 1500 để giả lập mạng chậm)
node scripts/e2e-telnet.mjs                   # telnet: tự đăng nhập, TTYPE/NAWS (server giả lập sẵn)
node scripts/e2e-glyphs.mjs                   # chụp màn hình kiểm tra lỗi ký tự bị vỡ (WebGL)
node scripts/e2e-db.mjs                       # database: tạo, chuyển dữ liệu cũ, đổi master password, lock/unlock, remember
node scripts/e2e-ui.mjs                       # màu, icon, toolbar hẹp, full screen, tab "thở", màu chữ terminal
node scripts/e2e-macro.mjs                    # macro picker, macro trong ô nhập, About (tự bật dev-ssh-server)
node scripts/e2e-sftp.mjs                     # SFTP up/down, trùng tên, tab bar (tự bật dev-ssh-server)
node scripts/e2e-shots.mjs [tên]              # chụp màn hình giao diện để so trước/sau
```

Các script e2e dùng profile tạm (`NIXI_USER_DATA`) và `NIXI_TEST_PASSWORD` để tự tạo/mở database. Đọc một file database: `node scripts/read-db.mjs path/to/nixi.nxdb <master password>`.

## Đóng gói cho macOS

Build `.dmg` phải chạy trên macOS. Push lên GitHub, workflow `.github/workflows/build-mac.yml` sẽ build bản arm64 (Apple Silicon) và x64 (Intel), tải về ở tab Actions → Artifacts. Hoặc trên một máy Mac:

```bash
npm ci && npm run dist:mac        # theo kiến trúc máy đang build
npm run dist:mac:arm64            # Mac chip M  → dist/Nixi-<version>-arm64.dmg (~66 MB)
npm run dist:mac:x64              # Mac Intel   → dist/Nixi-<version>-x64.dmg  (~75 MB)
```

File .dmg đã được làm nhỏ: chỉ giữ tiếng Anh + tiếng Việt của Chromium và nén LZMA (cần macOS 11+, cũng là mức tối thiểu của Electron 33).

Bản build hiện chưa ký (unsigned): lần đầu mở, chuột phải → Open. Nếu macOS báo "Nixi is damaged", chạy `xattr -cr /Applications/Nixi.app`. Để ký + notarize cần Apple Developer ID (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`…).

## Đóng gói cho Windows

```bash
npm run dist:win        # → dist/Nixi Setup <version>.exe (bản cài), dist/win-unpacked/ (chạy thẳng)
node scripts/e2e-packaged.mjs   # kiểm tra bản đã đóng gói: local shell, SSH, RDP
```

Lỗi `Cannot create symbolic link : A required privilege is not held` khi build: bật Windows *Developer Mode*, hoặc giải nén sẵn bộ công cụ ký của electron-builder (bỏ qua 2 symlink macOS không dùng tới):

```bash
7za x %LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<số>.7z -o%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0
```

Bản `.exe` chưa ký nên SmartScreen sẽ cảnh báo lần đầu: More info → Run anyway.

## Lộ trình tiếp theo (Phase 3)

- RDP: chuyển file qua clipboard, âm thanh, nhiều màn hình.
- Telnet / Serial, Mosh, X11 forwarding (XQuartz).
- Snippets, ghi log session ra file; gộp thay đổi khi cùng một database được sửa trên hai máy.

## Cấu trúc

```
src/shared/     types, parser (ssh_config, tree), macro format, MobaXterm format
src/main/       Electron main: store/ (database mã hoá, chuyển dữ liệu cũ), known hosts, SSH/SFTP/tunnels, PTY, menu,
                rdp/ (proxy RDCleanPath WebSocket → TLS), vnc/ (proxy WebSocket → TCP/SSH, VeNCrypt TLS), import/ (MobaXterm, giải mã macro)
src/preload/    API typed qua contextBridge
src/renderer/   React UI: sidebar (sessions/SFTP), tabs/panes, dialogs, xterm
scripts/        dev SSH server, e2e smoke test
```
