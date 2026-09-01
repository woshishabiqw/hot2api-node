# Start the fuck-gateway watchdog as an independent Windows process.
# This avoids the gateway being killed when the terminal/Shell session ends.
# It is NOT a Windows Service and does not require service installation.

$nodeExe = Join-Path $PSScriptRoot 'node-v22\node.exe'
$workingDir = $PSScriptRoot
$commandLine = '"{0}" --max-old-space-size=4096 start.js' -f $nodeExe

# Environment tweaks to reduce resource pressure and terminal noise under load.
$env:DISABLE_TRANSIT_SCAN = '1'
$env:LOG_LEVEL = 'info'

Write-Host "Starting fuck-gateway watchdog as independent process..." -ForegroundColor Green
Write-Host "  Node: $nodeExe" -ForegroundColor Gray
Write-Host "  Working dir: $workingDir" -ForegroundColor Gray

try {
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $commandLine
        CurrentDirectory = $workingDir
    }
    if ($result.ReturnValue -eq 0) {
        Write-Host "Started successfully. Watchdog PID: $($result.ProcessId)" -ForegroundColor Green
    } else {
        Write-Host "Failed to start. Win32_Process return value: $($result.ReturnValue)" -ForegroundColor Red
    }
} catch {
    Write-Host "Error starting process: $_" -ForegroundColor Red
}
