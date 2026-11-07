#!/bin/bash
# Edge-test campaign on Fuji: N back-to-back 15-minute dynamic markets, each traded by the
# edge bots, each settled/processed by one ops cycle (the keeper submits settlement).
# Every deployer transaction (market creation) runs from this script, sequentially.
#
#   N=10 ./scripts/ops/edge-campaign.sh
#   ALPHA=900 PER_BIN_CAP_UNITS=3500 TAU=0.03 DURATION_SEC=900 CUTOFF_SEC=120 START_DELAY_SEC=120
#   WALLET_SET=0          bot wallet set (use a different set per concurrently running campaign)
#   BOT_WALLETS_FILE=.env.bots.json   (testnet throwaway mnemonic; gitignored)
#   REDSTONE_GATEWAY_URL / REDSTONE_API_KEY   authenticated gateway (required once public gateways close)
#   GATE_URL              a Redstone endpoint to probe before each creation (default: public gateway 1);
#                         creation waits while it answers anything but 200, so a market is never opened
#                         when no payloads can be fetched for its trades and settlement
#   LOG_DIR=scripts/analysis/out/edge-bots
#   BOT_RPC_URL           RPC for the bots (default publicnode: the official endpoint rate-limits per IP;
#                         market creation stays on the default RPC because it needs pending-block gas estimates)
set -u
cd "$(dirname "$0")/../.." || exit 1
N=${N:-10}
export ALPHA=${ALPHA:-900} PER_BIN_CAP_UNITS=${PER_BIN_CAP_UNITS:-3500} TAU=${TAU:-0.03}
export DURATION_SEC=${DURATION_SEC:-900} CUTOFF_SEC=${CUTOFF_SEC:-120} START_DELAY_SEC=${START_DELAY_SEC:-120}
export WALLET_SET=${WALLET_SET:-0} BOT_WALLETS_FILE=${BOT_WALLETS_FILE:-.env.bots.json}
LOG_DIR=${LOG_DIR:-scripts/analysis/out/edge-bots}; mkdir -p "$LOG_DIR"
BOT_RPC_URL=${BOT_RPC_URL:-https://avalanche-fuji-c-chain-rpc.publicnode.com}
GATE_URL=${GATE_URL:-https://oracle-gateway-1.a.redstone.finance/data-packages/latest/redstone-primary-prod}
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG_DIR/campaign.log"; }
gate_ok() { [ "$(curl -s -m 10 -o /dev/null -w '%{http_code}' ${REDSTONE_API_KEY:+-H "x-api-key: $REDSTONE_API_KEY"} "$GATE_URL")" = "200" ]; }

log "campaign start: N=$N alpha=$ALPHA cap=$PER_BIN_CAP_UNITS tau=$TAU dur=${DURATION_SEC}s cutoff=${CUTOFF_SEC}s walletSet=$WALLET_SET"
for i in $(seq 1 "$N"); do
  until gate_ok; do log "redstone gateway not answering 200; waiting 60s"; sleep 60; done
  out=$(npx hardhat run scripts/ops/create-market-dynamic-avax.ts --network fuji 2>&1)
  id=$(echo "$out" | sed -n 's/.*Dynamic market created! marketId=\([0-9]*\).*/\1/p' | tail -1)
  if [ -z "$id" ]; then log "create failed ($i/$N): $(echo "$out" | grep -v Warning | tail -2 | tr '\n' ' ' | cut -c1-200)"; sleep 60; continue; fi
  log "market #$id created ($i/$N)"
  FUJI_RPC_URL=$BOT_RPC_URL MARKET_ID=$id NOISE_SEC=${NOISE_SEC:-90} ATM_SEC=${ATM_SEC:-150} TAIL_SEC=${TAIL_SEC:-240} SNIPE_SEC=${SNIPE_SEC:-120} \
    npx hardhat run scripts/ops/edge-bot.ts --network fuji >> "$LOG_DIR/bot-$id.log" 2>&1
  log "market #$id trading closed"
done
log "campaign done"
