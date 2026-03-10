import { ethers } from "hardhat";
import { expect } from "chai";
import { Signer } from "ethers";
import { IcicleOptionsPosition, IcicleOptionsUSDToken, TestERC1967Proxy } from "../../../typechain-types";

async function deployCoreSigner(): Promise<{ address: string; signer: Signer }> {
  const token = (await (
    await ethers.getContractFactory("IcicleOptionsUSDToken")
  ).deploy()) as IcicleOptionsUSDToken;
  await token.waitForDeployment();
  const address = await token.getAddress();
  await ethers.provider.send("hardhat_impersonateAccount", [address]);
  await ethers.provider.send("hardhat_setBalance", [
    address,
    ethers.toBeHex(ethers.parseEther("10")),
  ]);
  const signer = await ethers.getSigner(address);
  return { address, signer };
}

async function deployPosition(
  initialCore: string,
  ownerSafe: string
): Promise<IcicleOptionsPosition> {
  const implFactory = await ethers.getContractFactory("IcicleOptionsPosition");
  const impl = await implFactory.deploy();
  await impl.waitForDeployment();
  const initData = implFactory.interface.encodeFunctionData("initialize", [
    initialCore,
    ownerSafe,
  ]);
  const proxy = (await (
    await ethers.getContractFactory("TestERC1967Proxy")
  ).deploy(await impl.getAddress(), initData)) as TestERC1967Proxy;
  return (await ethers.getContractAt(
    "IcicleOptionsPosition",
    await proxy.getAddress()
  )) as IcicleOptionsPosition;
}

async function deployPositionFixture() {
  const [owner, user, alice, bob, carol] = await ethers.getSigners();
  const core = await deployCoreSigner();
  const position = await deployPosition(core.address, owner.address);
  return { position, core: core.signer, owner, user, alice, bob, carol };
}

describe("IcicleOptionsPosition", () => {
  it("enforces core-only mint/burn/update", async () => {
    const { position, core, user } = await deployPositionFixture();

    await expect(
      position.connect(user).mintPosition(user.address, 1, 0, 1, 1_000)
    )
      .to.be.revertedWithCustomError(position, "UnauthorizedCaller")
      .withArgs(user.address);

    await position.connect(core).mintPosition(user.address, 1, 0, 1, 1_000);
    await expect(
      position.connect(core).updateQuantity(1, 0)
    ).to.be.revertedWithCustomError(position, "InvalidQuantity");
    await position.connect(core).updateQuantity(1, 2_000);

    await expect(position.connect(user).burn(1)).to.be.revertedWithCustomError(
      position,
      "UnauthorizedCaller"
    );
    await position.connect(core).burn(1);
    await expect(position.getPosition(1)).to.be.revertedWithCustomError(
      position,
      "PositionNotFound"
    );
  });

  // ============================================================
  // Edge Cases: Range Validation
  // ============================================================
  describe("Edge Cases: Range Validation", () => {
    it("reverts burn on non-existent position", async () => {
      const { position, core } = await deployPositionFixture();

      // Burn non-existent position (ID 999)
      await expect(position.connect(core).burn(999)).to.be.reverted;
    });

    it("reverts double burn", async () => {
      const { position, core, user } = await deployPositionFixture();

      await position.connect(core).mintPosition(user.address, 1, 0, 1, 1_000);
      await position.connect(core).burn(1);

      // Double burn should fail
      await expect(position.connect(core).burn(1)).to.be.reverted;
    });

    it("handles maximum quantity value", async () => {
      const { position, core, user } = await deployPositionFixture();

      // Max uint128 quantity
      const maxQty = 2n ** 128n - 1n;
      await position.connect(core).mintPosition(user.address, 1, 0, 1, maxQty);

      const pos = await position.getPosition(1);
      expect(pos.quantity).to.equal(maxQty);
    });

    it("handles zero-based tick ranges", async () => {
      const { position, core, user } = await deployPositionFixture();

      // Mint at [0, 1) range
      await position.connect(core).mintPosition(user.address, 1, 0, 1, 1_000);
      const pos = await position.getPosition(1);
      expect(pos.lowerTick).to.equal(0);
      expect(pos.upperTick).to.equal(1);
    });
  });

  it("tracks owner indices across mint/transfer/burn", async () => {
    const { position, core, alice, bob } = await deployPositionFixture();
    await position.connect(core).mintPosition(alice.address, 1, 0, 2, 1_000);
    await position.connect(core).mintPosition(alice.address, 1, 2, 4, 1_000);

    expect(await position.getPositionsByOwner(alice.address)).to.deep.equal([
      1n,
      2n,
    ]);

    await position
      .connect(alice)
      ["safeTransferFrom(address,address,uint256)"](
        alice.address,
        bob.address,
        1
      );
    expect(await position.getPositionsByOwner(alice.address)).to.deep.equal([
      2n,
    ]);
    expect(await position.getPositionsByOwner(bob.address)).to.deep.equal([1n]);

    await position.connect(core).burn(2);
    expect(await position.getPositionsByOwner(alice.address)).to.deep.equal([]);
  });

  it("provides market indexing with hole markers", async () => {
    const { position, core, alice } = await deployPositionFixture();
    await position.connect(core).mintPosition(alice.address, 7, 0, 1, 1_000);
    await position.connect(core).mintPosition(alice.address, 7, 1, 2, 1_000);
    await position.connect(core).mintPosition(alice.address, 7, 2, 3, 1_000);

    expect(await position.getMarketTokenLength(7)).to.equal(3);
    await position.connect(core).burn(2);
    expect(await position.getMarketTokenLength(7)).to.equal(3); // hole remains
    expect(await position.getMarketTokenAt(7, 1)).to.equal(0);
    expect(await position.getMarketPositions(7)).to.deep.equal([1n, 0n, 3n]);
  });

  it("filters user positions per market", async () => {
    const { position, core, alice, bob } = await deployPositionFixture();
    await position.connect(core).mintPosition(alice.address, 5, 0, 1, 1_000);
    await position.connect(core).mintPosition(bob.address, 5, 1, 2, 1_000);
    await position.connect(core).mintPosition(alice.address, 6, 0, 1, 1_000);

    expect(
      await position.getUserPositionsInMarket(alice.address, 5)
    ).to.deep.equal([1n]);
    expect(
      await position.getUserPositionsInMarket(bob.address, 5)
    ).to.deep.equal([2n]);
    expect(
      await position.getUserPositionsInMarket(alice.address, 6)
    ).to.deep.equal([3n]);
  });

  it("keeps owner/market indices consistent across multi-market transfer and burn", async () => {
    const { position, core, alice, bob } = await deployPositionFixture();

    await position.connect(core).mintPosition(alice.address, 1, 0, 1, 1_000); // id 1
    await position.connect(core).mintPosition(alice.address, 1, 1, 2, 1_000); // id 2
    await position.connect(core).mintPosition(bob.address, 1, 2, 3, 1_000); // id 3
    await position.connect(core).mintPosition(alice.address, 2, 0, 1, 1_000); // id 4

    const sort = (vals: bigint[]) =>
      vals.map((v) => Number(v)).sort((a, b) => a - b);

    expect(
      sort(await position.getPositionsByOwner(alice.address))
    ).to.deep.equal([1, 2, 4]);
    expect(sort(await position.getPositionsByOwner(bob.address))).to.deep.equal(
      [3]
    );

    expect(await position.getMarketTokenLength(1)).to.equal(3);
    expect(await position.getMarketPositions(1)).to.deep.equal([1n, 2n, 3n]);
    expect(await position.getMarketPositions(2)).to.deep.equal([4n]);
    expect(
      sort(await position.getUserPositionsInMarket(alice.address, 1))
    ).to.deep.equal([1, 2]);
    expect(
      sort(await position.getUserPositionsInMarket(bob.address, 1))
    ).to.deep.equal([3]);

    // transfer position 2 from alice to bob
    await position
      .connect(alice)
      ["safeTransferFrom(address,address,uint256)"](
        alice.address,
        bob.address,
        2
      );
    expect(
      sort(await position.getPositionsByOwner(alice.address))
    ).to.deep.equal([1, 4]);
    expect(sort(await position.getPositionsByOwner(bob.address))).to.deep.equal(
      [2, 3]
    );
    expect(
      sort(await position.getUserPositionsInMarket(alice.address, 1))
    ).to.deep.equal([1]);
    expect(
      sort(await position.getUserPositionsInMarket(bob.address, 1))
    ).to.deep.equal([2, 3]);

    // burn position 3 (bob, market 1) leaves hole in market list
    await position.connect(core).burn(3);
    expect(await position.getMarketPositions(1)).to.deep.equal([1n, 2n, 0n]);
    expect(sort(await position.getPositionsByOwner(bob.address))).to.deep.equal(
      [2]
    );
    expect(
      sort(await position.getUserPositionsInMarket(bob.address, 1))
    ).to.deep.equal([2]);
    expect(await position.getMarketTokenAt(1, 2)).to.equal(0); // hole marker
  });

  it("mirrors JS state across random mint/transfer/burn sequence", async () => {
    const { position, core, alice, bob, carol } = await deployPositionFixture();

    type PosState = {
      owner: string;
      market: number;
      alive: boolean;
      marketIndex: number;
    };
    const states: Record<number, PosState> = {};
    const ownerLists: Record<string, number[]> = {
      [alice.address]: [],
      [bob.address]: [],
      [carol.address]: [],
    };
    const marketLists: Record<number, number[]> = {};

    let nextId = 1;
    function addOwner(owner: string, id: number) {
      ownerLists[owner].push(id);
    }
    function removeOwner(owner: string, id: number) {
      const arr = ownerLists[owner];
      const idx = arr.indexOf(id);
      if (idx >= 0) {
        arr.splice(idx, 1);
      }
    }

    async function mint(
      owner: any,
      market: number,
      lower: number,
      upper: number
    ) {
      const id = nextId++;
      await position
        .connect(core)
        .mintPosition(owner.address, market, lower, upper, 1_000);
      if (!marketLists[market]) marketLists[market] = [];
      marketLists[market].push(id);
      states[id] = {
        owner: owner.address,
        market,
        alive: true,
        marketIndex: marketLists[market].length,
      };
      addOwner(owner.address, id);
      return id;
    }

    async function transfer(from: any, to: any, id: number) {
      await position
        .connect(from)
        ["safeTransferFrom(address,address,uint256)"](
          from.address,
          to.address,
          id
        );
      removeOwner(from.address, id);
      addOwner(to.address, id);
      states[id].owner = to.address;
    }

    async function burn(id: number) {
      await position.connect(core).burn(id);
      const st = states[id];
      st.alive = false;
      const arr = marketLists[st.market];
      arr[st.marketIndex - 1] = 0;
      removeOwner(st.owner, id);
    }

    // deterministic pseudo-random sequence
    const ops = 20;
    let seed = 12345;
    function rand(max: number) {
      seed = (seed * 1664525 + 1013904223) % 0xffffffff;
      return seed % max;
    }
    const users = [alice, bob, carol];
    for (let i = 0; i < ops; i++) {
      const action = rand(3);
      if (action === 0 || Object.keys(states).length === 0) {
        // mint
        const owner = users[rand(users.length)];
        const market = (rand(3) % 3) + 1;
        const lower = rand(3);
        const upper = lower + 1;
        await mint(owner, market, lower, upper);
      } else if (action === 1) {
        // transfer
        const aliveIds = Object.keys(states)
          .map(Number)
          .filter((id) => states[id].alive);
        const id = aliveIds[rand(aliveIds.length)];
        const currentOwner = states[id].owner;
        const to = users[rand(users.length)];
        if (to.address === currentOwner) continue;
        const fromSigner = users.find((u) => u.address === currentOwner)!;
        await transfer(fromSigner, to, id);
      } else {
        // burn
        const aliveIds = Object.keys(states)
          .map(Number)
          .filter((id) => states[id].alive);
        if (aliveIds.length === 0) continue;
        const id = aliveIds[rand(aliveIds.length)];
        await burn(id);
      }
    }

    // assertions vs contract
    const list1 = await position.getMarketPositions(1);
    const list2 = await position.getMarketPositions(2);
    expect(list1.map(Number)).to.deep.equal(marketLists[1].map(Number));
    expect(list2.map(Number)).to.deep.equal(marketLists[2].map(Number));

    expect(
      (await position.getUserPositionsInMarket(alice.address, 1))
        .map(Number)
        .sort()
    ).to.deep.equal(
      ownerLists[alice.address].filter((id) => states[id].market === 1).sort()
    );
    expect(
      (await position.getUserPositionsInMarket(bob.address, 1))
        .map(Number)
        .sort()
    ).to.deep.equal(
      ownerLists[bob.address].filter((id) => states[id].market === 1).sort()
    );
    expect(
      (await position.getUserPositionsInMarket(carol.address, 1))
        .map(Number)
        .sort()
    ).to.deep.equal(
      ownerLists[carol.address].filter((id) => states[id].market === 1).sort()
    );
  });
});
