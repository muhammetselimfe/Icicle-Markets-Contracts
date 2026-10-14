import hre from "hardhat";
async function main() {
  const core = await hre.ethers.getContractAt("IcicleOptionsCore", "0x5163b4aB77650D1D937a5c5E6B0d012e4659546e");
  for (const id of [16,17,18,20,21,22,23,24,25]) {
    const m = await core.markets(id);
    console.log(`Market #${id}: settled=${m.settled}, failed=${m.failed}, bins=${m.numBins}, alpha=${m.liquidityParameter / (10n**18n)} WAD, settleTick=${m.settlementTick}, range=${m.minTick}-${m.maxTick}, spacing=${m.tickSpacing}`);
  }
}
main().catch(console.error);
