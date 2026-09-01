# 先停止所有项目内的 node 进程，确保端口释放
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*测试Traa*node-v22*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

$env:LOG_LEVEL = if ($env:LOG_LEVEL) { $env:LOG_LEVEL } else { 'info' }
$env:DISABLE_TRANSIT_SCAN = if ($env:DISABLE_TRANSIT_SCAN) { $env:DISABLE_TRANSIT_SCAN } else { '1' }

Start-Process `
  -FilePath "E:/Desktop/测试Traa/backend/node-v22/node.exe" `
  -ArgumentList "src/index.js" `
  -WorkingDirectory "E:/Desktop/测试Traa/backend" `
  -WindowStyle Hidden `
  -RedirectStandardOutput "../logs/index-single.log" `
  -RedirectStandardError "../logs/index-single-err.log"

Write-Host "Gateway started as single instance. Logs: logs/index-single.log"
