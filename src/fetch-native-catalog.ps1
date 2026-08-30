$ErrorActionPreference = 'Stop'

try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $authorization = [string]$request.authorization
    $accountId = [string]$request.accountId
    $clientVersion = [string]$request.clientVersion
    if ($authorization -notmatch '^Bearer [^\r\n]{16,}$') {
        throw 'authorization_invalid'
    }
    if ($accountId -and $accountId -notmatch '^[A-Za-z0-9_-]{1,128}$') {
        throw 'account_id_invalid'
    }
    if ($clientVersion -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') {
        throw 'client_version_invalid'
    }

    # PowerShell 的 HttpClient 使用 Windows 代理设置；凭据只从 stdin 进入当前进程。
    $headers = @{
        Authorization = $authorization
        Accept = 'application/json'
        'User-Agent' = "codex_cli_rs/$clientVersion"
    }
    if ($accountId) {
        $headers['ChatGPT-Account-Id'] = $accountId
    }
    $endpoint = 'https://chatgpt.com/backend-api/codex/models?client_version=' + `
        [Uri]::EscapeDataString($clientVersion)
    $response = Invoke-WebRequest `
        -Uri $endpoint `
        -Method Get `
        -Headers $headers `
        -SkipHttpErrorCheck `
        -TimeoutSec 30
    $status = [int]$response.StatusCode
    if ($status -lt 200 -or $status -ge 300) {
        [Console]::Out.Write((@{ ok = $false; status = $status } | ConvertTo-Json -Compress))
        exit 41
    }
    if ($response.RawContentLength -gt 16777216) {
        throw 'catalog_too_large'
    }
    [Console]::Out.Write([string]$response.Content)
    exit 0
}
catch {
    # 错误输出只保留固定分类，绝不包含响应正文或认证头。
    [Console]::Error.Write('native_catalog_fetch_failed')
    exit 42
}
