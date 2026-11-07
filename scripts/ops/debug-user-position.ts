import hre from "hardhat";
import { loadEnvironment } from "../utils/environment";

async function main() {
  const { ethers } = hre;
  const env = loadEnvironment("fuji");
  const core = await ethers.getContractAt("IcicleOptionsCore", env.contracts.IcicleOptionsCoreProxy);

  const userAddr = "0x06200eC0Ea4E888EcfD6EB4F7Aec78e672d84370";
  const marketId = 51n;
  const lower = 960n;
  const upper = 965n;

  // Check payment token balance & allowance
  const paymentAddr = await core.paymentToken();
  const payment = await ethers.getContractAt("IERC20", paymentAddr);
  const balance = await payment.balanceOf(userAddr);
  const allowance = await payment.allowance(userAddr, env.contracts.IcicleOptionsCoreProxy);
  console.log(`Payment token: ${paymentAddr}`);
  console.log(`User balance: $${(Number(balance) / 1e6).toFixed(2)}`);
  console.log(`User allowance to core: $${(Number(allowance) / 1e6).toFixed(2)}`);

  // Check market state
  const m = await core.markets(marketId);
  const now = Math.floor(Date.now() / 1000);
  console.log(`\nMarket #51: seeded=${m.isSeeded}, settled=${m.settled}`);
  console.log(`Now: ${now}, start: ${m.startTimestamp}, end: ${m.endTimestamp}`);
  console.log(`Active: ${now >= Number(m.startTimestamp) && now < Number(m.endTimestamp)}`);
  console.log(`Expired: ${now >= Number(m.endTimestamp)}`);

  // Try staticCall as the user (impersonate)
  const qty = 100_000_000n; // probe
  try {
    const cost = await core.calculateOpenCost.staticCall(marketId, lower, upper, qty);
    console.log(`\ncalculateOpenCost(qty=${qty}): $${(Number(cost)/1e6).toFixed(4)}`);
  } catch (e: any) {
    console.log(`\ncalculateOpenCost error: ${e.message?.slice(0, 200)}`);
  }

  // Simulate openPosition from user's address using eth_call
  const probeQty = 50_000_000n;
  try {
    const cost = await core.calculateOpenCost.staticCall(marketId, lower, upper, probeQty);
    const maxCost = cost + (cost * 1000n) / 10000n; // 10% slippage
    console.log(`\nProbe: qty=${probeQty}, cost=$${(Number(cost)/1e6).toFixed(2)}, maxCost=$${(Number(maxCost)/1e6).toFixed(2)}`);

    // Encode the call
    const calldata = core.interface.encodeFunctionData("openPosition", [
      marketId, lower, upper, probeQty, maxCost
    ]);

    // eth_call from user address
    const result = await ethers.provider.call({
      to: env.contracts.IcicleOptionsCoreProxy,
      from: userAddr,
      data: calldata,
    });
    console.log(`eth_call result: ${result}`);
  } catch (e: any) {
    console.log(`\neth_call from user reverted!`);
    console.log(`Message: ${e.message?.slice(0, 300)}`);
    if (e.data) {
      console.log(`Error data: ${e.data}`);
      // Try decoding
      const allErrors = [
        "error AlphaExceedsLimit(uint256)",
        "error MarketNotActive(uint256)",
        "error MarketNotSeeded(uint256)",
        "error MarketExpired(uint256)",
        "error MarketNotStarted(uint256)",
        "error CostExceedsMaximum(uint256,uint256)",
        "error InvalidTickRange(int256,int256)",
        "error InvalidQuantity(uint128)",
        "error InsufficientBalance(uint256,uint256)",
        "error BatchAlreadyProcessed(uint64)",
      ];
      try {
        const iface = new ethers.Interface(allErrors);
        const decoded = iface.parseError(e.data);
        console.log(`Decoded: ${decoded?.name}(${decoded?.args.join(", ")})`);
      } catch {}

      // Also try ERC20 errors
      try {
        const erc20Errors = [
          "error ERC20InsufficientAllowance(address,uint256,uint256)",
          "error ERC20InsufficientBalance(address,uint256,uint256)",
        ];
        const iface2 = new ethers.Interface(erc20Errors);
        const decoded2 = iface2.parseError(e.data);
        console.log(`ERC20 error: ${decoded2?.name}(${decoded2?.args.join(", ")})`);
      } catch {}
    }
  }

  // Also try from deployer for comparison
  try {
    const cost = await core.calculateOpenCost.staticCall(marketId, lower, upper, probeQty);
    const maxCost = cost + (cost * 1000n) / 10000n;
    const result = await core.openPosition.staticCall(marketId, lower, upper, probeQty, maxCost);
    console.log(`\nDeployer staticCall: OK, positionId=${result}`);
  } catch (e: any) {
    console.log(`\nDeployer also fails: ${e.message?.slice(0, 200)}`);
  }
}
main().catch(console.error);
