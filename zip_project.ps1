Add-Type -AssemblyName System.IO.Compression.FileSystem

$sourceDir = $PWD.Path
$zipPath = Join-Path $sourceDir "ryewired-project.zip"
$tempDir = Join-Path $env:TEMP "ryewired-staging"
$exclude = @("node_modules", "dev", ".DS_Store", "ryewired-project.zip", "ZipProject.ps1", ".git")

# Clean up
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

New-Item -ItemType Directory -Path $tempDir | Out-Null

# Copy files, filtering out the excluded names
Get-ChildItem -Path $sourceDir -Recurse | Where-Object {
    $item = $_
    $shouldExclude = $false
    foreach ($ex in $exclude) {
        if ($item.FullName -like "*\$ex*") { $shouldExclude = $true; break }
    }
    -not $shouldExclude
} | ForEach-Object {
    $dest = $_.FullName.Replace($sourceDir, $tempDir)
    if ($_.PSIsContainer) {
        if (!(Test-Path $dest)) { New-Item -ItemType Directory -Path $dest | Out-Null }
    } else {
        Copy-Item -Path $_.FullName -Destination $dest
    }
}

# Create the ZIP
[System.IO.Compression.ZipFile]::CreateFromDirectory($tempDir, $zipPath)

# Clean up
Remove-Item $tempDir -Recurse -Force
Write-Host "Success! Created $zipPath" -ForegroundColor Green