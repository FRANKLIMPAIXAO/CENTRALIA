#!/bin/bash
# ═══════════════════════════════════════
#   Central IA — Auto-Start
#   Duplo clique para iniciar
# ═══════════════════════════════════════

DIR="$(cd "$(dirname "$0")" && pwd)/backend"

# Mata instância anterior se existir
pkill -f "node server.js" 2>/dev/null
sleep 1

echo ""
echo "╔══════════════════════════════════╗"
echo "║       CENTRAL IA — INICIANDO     ║"
echo "╚══════════════════════════════════╝"
echo ""

# Lê a API key do .env
if [ -f "$DIR/.env" ]; then
  export $(grep -v '^#' "$DIR/.env" | xargs)
fi

# Inicia o servidor
cd "$DIR"
node server.js &
SERVER_PID=$!
sleep 2

# Verifica se subiu
if curl -s http://localhost:3001/api/health > /dev/null 2>&1; then
  echo ""
  echo "✅  Servidor rodando em http://localhost:3001"
  echo "🌐  Abrindo no navegador..."
  open "http://localhost:3001"
  echo ""
  echo "──────────────────────────────────"
  echo "  Feche esta janela para encerrar"
  echo "──────────────────────────────────"
  wait $SERVER_PID
else
  echo "❌  Falha ao iniciar. Verifique a API key no arquivo .env"
  read -p "Pressione ENTER para fechar..."
fi
