@echo off
chcp 65001 >nul
echo 正在带调试端口启动知犀客户端...
echo 如果知犀已经在运行，请先完全退出（含托盘图标），否则参数不会生效。
start "" "C:\Program Files\ZhiXi\ZXMind\zhiximind-desktop.exe" ^
  --remote-debugging-port=19222 ^
  --remote-allow-origins=* ^
  --disable-backgrounding-occluded-windows ^
  --disable-renderer-backgrounding ^
  --disable-features=CalculateNativeWinOcclusion
echo 已启动。等 5 秒后可用 zhixi_status 检查连通性。
timeout /t 5 >nul
