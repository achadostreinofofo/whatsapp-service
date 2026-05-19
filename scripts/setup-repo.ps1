# setup-repo.ps1
# Cria o repositório GitHub, configura proteção do master e inicializa o git.
# Uso: .\scripts\setup-repo.ps1 -Token "ghp_SEU_TOKEN"

param(
    [Parameter(Mandatory)]
    [string]$Token,
    [string]$Org   = "achadostreinofofo",
    [string]$Repo  = "whatsapp-service"
)

$headers = @{
    Authorization = "Bearer $Token"
    Accept        = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
}

# ── 1. Criar repositório ───────────────────────────────────────────
Write-Host "Criando repositório $Org/$Repo..." -ForegroundColor Cyan

$body = @{
    name        = $Repo
    description = "WhatsApp Web session manager — GrupoLink microservice"
    private     = $true
    auto_init   = $false
} | ConvertTo-Json

try {
    $result = Invoke-RestMethod `
        -Uri "https://api.github.com/user/repos" `
        -Method POST `
        -Headers $headers `
        -Body $body `
        -ContentType "application/json"
    Write-Host "Repositório criado: $($result.html_url)" -ForegroundColor Green
} catch {
    $msg = $_.ErrorDetails.Message | ConvertFrom-Json
    if ($msg.errors[0].message -like "*already exists*") {
        Write-Host "Repositório já existe — continuando..." -ForegroundColor Yellow
    } else {
        Write-Error "Erro ao criar repositório: $($msg.message)"
        exit 1
    }
}

# ── 2. Push inicial ───────────────────────────────────────────────
Write-Host "`nInicializando git e fazendo push inicial..." -ForegroundColor Cyan

$repoRoot = Split-Path $PSScriptRoot -Parent

Push-Location $repoRoot
try {
    if (-not (Test-Path ".git")) {
        git init
        git checkout -b master
    }

    git add .
    git commit -m "chore: initial commit — whatsapp-service standalone repo" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Nada para commitar — repositório já tem commits" -ForegroundColor Yellow
    }

    $remoteUrl = "https://github.com/$Org/$Repo.git"
    git remote remove origin 2>$null
    git remote add origin $remoteUrl
    git push -u origin master
    Write-Host "Push realizado com sucesso" -ForegroundColor Green
} finally {
    Pop-Location
}

# ── 3. Criar branch develop ──────────────────────────────────────
Write-Host "`nCriando branch develop..." -ForegroundColor Cyan

# Busca SHA do master
$masterRef = Invoke-RestMethod `
    -Uri "https://api.github.com/repos/$Org/$Repo/git/refs/heads/master" `
    -Headers $headers

$sha = $masterRef.object.sha

$body = @{ ref = "refs/heads/develop"; sha = $sha } | ConvertTo-Json
try {
    Invoke-RestMethod `
        -Uri "https://api.github.com/repos/$Org/$Repo/git/refs" `
        -Method POST -Headers $headers -Body $body -ContentType "application/json" | Out-Null
    Write-Host "Branch develop criada" -ForegroundColor Green
} catch {
    Write-Host "Branch develop já existe" -ForegroundColor Yellow
}

# ── 4. Proteção do master ─────────────────────────────────────────
Write-Host "`nConfigurando proteção do master..." -ForegroundColor Cyan

$protection = @{
    required_status_checks = @{
        strict   = $true
        contexts = @("Syntax check & Docker build")
    }
    enforce_admins                  = $true
    required_pull_request_reviews   = @{
        required_approving_review_count = 1
        dismiss_stale_reviews           = $true
    }
    restrictions = $null
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
    -Uri "https://api.github.com/repos/$Org/$Repo/branches/master/protection" `
    -Method PUT -Headers $headers -Body $protection -ContentType "application/json" | Out-Null

Write-Host "Master protegida: PRs obrigatórios + CI deve passar" -ForegroundColor Green

# ── 5. Instruções para os secrets do GitHub ───────────────────────
Write-Host @"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Próximos passos:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Deploy da infra AWS (rode apenas uma vez):
   aws cloudformation deploy \
     --template-file infra/cloudformation.yml \
     --stack-name whatsapp-service \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides \
       VpcId=vpc-XXXXX \
       SubnetId=subnet-XXXXX \
       BackendSecurityGroupId=sg-XXXXX

2. Anote os Outputs do CloudFormation e adicione os
   seguintes secrets em:
   https://github.com/$Org/$Repo/settings/secrets/actions

   AWS_ROLE_ARN     → GitHubActionsRoleArn (Output do CF)
   EC2_INSTANCE_ID  → InstanceId (Output do CF)

3. Crie os parâmetros SSM com as variáveis de ambiente
   do container:
   aws ssm put-parameter --name /whatsapp-service/API_SECRET \
     --value "SEU_SECRET" --type SecureString
   aws ssm put-parameter --name /whatsapp-service/LOG_LEVEL \
     --value "info" --type String
   aws ssm put-parameter --name /whatsapp-service/SESSIONS_DIR \
     --value "/app/sessions" --type String

4. Configure o backend para apontar para o IP privado
   da EC2 (Output PrivateIp do CF):
   app.whatsapp-service.url=http://PRIVATE_IP:3001
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"@ -ForegroundColor Cyan
