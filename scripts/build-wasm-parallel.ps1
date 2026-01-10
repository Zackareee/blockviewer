# Build WASM with parallel support (Rayon) - Windows PowerShell version
# This script ensures the correct Rust toolchain is installed and configured

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$WasmDir = Join-Path $ProjectRoot "src\wasm-mesher"

Write-Host "=== Building WASM with parallel support ===" -ForegroundColor Cyan

# Check if rustup is installed
if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) {
    Write-Host "Error: rustup is not installed. Please install from https://rustup.rs" -ForegroundColor Red
    exit 1
}

# Check if nightly toolchain is installed
$toolchains = rustup toolchain list
if (-not ($toolchains -match "nightly")) {
    Write-Host "Installing nightly Rust toolchain..."
    rustup toolchain install nightly
}

# Add wasm32 target to nightly if not present
$targets = rustup +nightly target list --installed
if (-not ($targets -match "wasm32-unknown-unknown")) {
    Write-Host "Adding wasm32-unknown-unknown target to nightly..."
    rustup +nightly target add wasm32-unknown-unknown
}

# Add rust-src component for build-std
$components = rustup +nightly component list --installed
if (-not ($components -match "rust-src")) {
    Write-Host "Adding rust-src component to nightly..."
    rustup +nightly component add rust-src
}

# Check if wasm-pack is installed
if (-not (Get-Command wasm-pack -ErrorAction SilentlyContinue)) {
    Write-Host "Installing wasm-pack..."
    cargo install wasm-pack
}

# Build with parallel feature
Write-Host "Building WASM with parallel feature..."
Push-Location $WasmDir

try {
    # Use nightly toolchain for build-std support
    $env:RUSTUP_TOOLCHAIN = "nightly"
    wasm-pack build --target web --release --features parallel --out-dir ../wasm/pkg
    
    # Copy to public directory
    Write-Host "Copying to public/wasm..."
    Copy-Item -Path (Join-Path $WasmDir "..\wasm\pkg\*") -Destination (Join-Path $ProjectRoot "public\wasm") -Recurse -Force
    
    Write-Host "=== Build complete ===" -ForegroundColor Green
    Write-Host "WASM with Rayon parallel support built successfully!" -ForegroundColor Green
}
finally {
    Pop-Location
}
