// Giwajang — a minimal launchpad on GIWA Sepolia built with the Ammora SDK.
// Config derivation below is adapted from the MIT-licensed ammora-examples
// (src/launch/config-from-template.ts) by KreoLabs.
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  parseUnits,
  formatUnits,
  erc20Abi,
  encodeFunctionData,
  getAddress,
  type Address,
  type WalletClient,
} from 'viem';
import {
  createConfigAndPoolWithFirstBuy,
  giwaSepoliaAtomicLaunchDeployment,
  giwaSepoliaAutoRouteDeployment,
  getAmmoraV4ConfigAtBlock,
  buildSingleSegmentCurve,
  concentratedDepositQuote,
  assertAmmoraV4Config,
  AmmoraV4MigrationMode,
  AmmoraV4LaunchCurveClient,
  ammoraLaunchPoolV4Abi,
  parseAmmoraV4LaunchCreatedReceipt,
} from '@ammora-protocol/sdk';

const RPC = 'https://sepolia-rpc.giwa.io';
const EXPLORER = 'https://sepolia-explorer.giwa.io';
const WETH = '0x4200000000000000000000000000000000000006' as Address;
const TEMPLATE_ID = 6n;
// Reviewed template hash for Config #6, verified on-chain 2026-11-16.
const TEMPLATE_HASH = '0x6048908774397e0691bb0e19f72dabb790eb0d892d6081d3622b39e7f738e667';
const STORE_KEY = 'giwajang.launches.v1';

const chain = defineChain({
  id: 91342,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: 'GIWA Sepolia Explorer', url: EXPLORER } },
});

// Loosely typed on purpose: viem's generic inference fights the SDK's client
// types; runtime behavior is verified in the browser instead.
const pub: any = createPublicClient({ chain, transport: http(RPC) });

const launchContracts = (giwaSepoliaAutoRouteDeployment as any).contracts.launch;
const CORE = {
  configRegistry: launchContracts.configRegistry as Address,
  launchFactory: launchContracts.factory as Address,
  graduationAdapter: launchContracts.graduationAdapter as Address,
  feePolicy: launchContracts.feePolicy as Address,
};
const REGISTRY = (giwaSepoliaAtomicLaunchDeployment as any).contracts.configRegistry as Address;
const FACTORY = CORE.launchFactory;

const WETH_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
] as const;

type Launch = { token: Address; curve: Address; name: string; symbol: string };
const DEFAULT_LAUNCHES: Launch[] = [
  {
    token: '0x271a58D6De6f0c10242a5aB01dE081E509dE7104',
    curve: '0x1038B6c1A34669677A0cB92a3eC8a03d658924f0',
    name: 'Giwamora',
    symbol: 'GMORA',
  },
];

function loadLaunches(): Launch[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const extra: Launch[] = raw ? JSON.parse(raw) : [];
    const seen = new Set<string>();
    return [...DEFAULT_LAUNCHES, ...extra].filter((l) => {
      const k = l.token.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  } catch {
    return [...DEFAULT_LAUNCHES];
  }
}
function saveLaunch(l: Launch) {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const extra: Launch[] = raw ? JSON.parse(raw) : [];
    extra.push(l);
    localStorage.setItem(STORE_KEY, JSON.stringify(extra));
  } catch { /* storage unavailable */ }
}

let launches = loadLaunches();
let account: Address | null = null;
let wallet: any = null;
let direction: 'buy' | 'sell' = 'buy';

const $ = (id: string) => document.getElementById(id)!;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const txLink = (h: string) => `<a href="${EXPLORER}/tx/${h}" target="_blank" rel="noreferrer">${short(h)}</a>`;
const addrLink = (a: string) => `<a href="${EXPLORER}/address/${a}" target="_blank" rel="noreferrer">${short(a)}</a>`;

function log(el: HTMLElement, msg: string, cls = '') {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.innerHTML = msg;
  el.appendChild(div);
}

const metaCache = new Map<string, { name: string; symbol: string; decimals: number }>();
async function tokenMeta(token: Address) {
  const key = token.toLowerCase();
  const hit = metaCache.get(key);
  if (hit) return hit;
  const [name, symbol, decimals] = await Promise.all([
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'name' }),
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  const meta = { name, symbol, decimals };
  metaCache.set(key, meta);
  return meta;
}

function curveClient(curve: Address) {
  return new AmmoraV4LaunchCurveClient(pub as any, curve, CORE as any);
}

async function renderMarkets() {
  const list = $('marketList');
  const block = await pub.getBlockNumber();
  const cards: string[] = [];
  for (const l of launches) {
    try {
      const state: any = await curveClient(l.curve).getStateAtBlock(block);
      const meta = await tokenMeta(l.token);
      const ratio = Number(state.sqrtPrice) / 2 ** 64;
      const priceRaw = ratio * ratio; // quote wei per raw base unit
      const perMillion = (priceRaw * 1e6 * 10 ** meta.decimals) / 1e18;
      const progress = state.migrationQuoteThreshold > 0n
        ? Math.min(100, Number((state.quoteReserve * 10000n) / state.migrationQuoteThreshold) / 100)
        : 0;
      const graduated = state.canonicalPool && state.canonicalPool !== '0x0000000000000000000000000000000000000000';
      const status = graduated ? '🎓 Graduated' : state.status === 1 ? '● Live on curve' : `Status ${state.status}`;
      let balanceLine = '';
      if (account) {
        const bal = await pub.readContract({ address: l.token, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
        balanceLine = `<div><b>Your balance</b>${formatUnits(bal, meta.decimals)} ${meta.symbol}</div>`;
      }
      cards.push(`
        <div class="market">
          <div class="market-head">
            <div class="market-name">${meta.name} <span>$${meta.symbol}</span></div>
            <div class="status ${!graduated && state.status === 1 ? 'live' : ''}">${status}</div>
          </div>
          <div class="market-meta">
            <div><b>Price</b>${perMillion.toFixed(8)} WETH / 1M ${meta.symbol}</div>
            <div><b>Curve reserve</b>${formatUnits(state.quoteReserve, 18)} WETH</div>
            <div><b>Graduation</b>${progress.toFixed(1)}% of ${formatUnits(state.migrationQuoteThreshold, 18)} WETH
              <div class="progress"><div style="width:${progress}%"></div></div></div>
            <div><b>Token</b><span class="mono">${addrLink(l.token)}</span></div>
            <div><b>Curve</b><span class="mono">${addrLink(l.curve)}</span></div>
            <div><b>Config</b>#${state.configId}</div>
            ${balanceLine}
          </div>
        </div>`);
    } catch (e: any) {
      cards.push(`<div class="market"><div class="market-name">${l.name} <span>$${l.symbol}</span></div><p class="muted">Could not load curve state: ${e?.shortMessage ?? e?.message ?? e}</p></div>`);
    }
  }
  list.innerHTML = cards.join('');
  const sel = $('tradeToken') as HTMLSelectElement;
  const current = sel.value;
  sel.innerHTML = launches.map((l) => `<option value="${l.token}">${l.name} ($${l.symbol})</option>`).join('');
  if (current && launches.some((l) => l.token === current)) sel.value = current;
}

async function connect() {
  const eth = (window as any).ethereum;
  if (!eth) {
    alert('No browser wallet found. Install MetaMask (or another injected wallet) and reload.');
    return;
  }
  const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x164ce' }] });
  } catch (e: any) {
    if (e?.code === 4902) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: '0x164ce', chainName: 'GIWA Sepolia',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [RPC], blockExplorerUrls: [EXPLORER],
        }],
      });
    } else throw e;
  }
  account = getAddress(accounts[0]);
  wallet = createWalletClient({ account, chain, transport: custom(eth) });
  $('connectBtn').textContent = short(account);
  await renderMarkets();
}

// ---------------- Trade ----------------

function selectedLaunch(): Launch {
  const token = ($('tradeToken') as HTMLSelectElement).value;
  return launches.find((l) => l.token === token) ?? launches[0];
}

async function readTradeInputs() {
  const l = selectedLaunch();
  const meta = await tokenMeta(l.token);
  const raw = ($('tradeAmount') as HTMLInputElement).value.trim();
  if (!raw) throw new Error('Enter an amount first.');
  const amountIn = direction === 'buy' ? parseUnits(raw, 18) : parseUnits(raw, meta.decimals);
  if (amountIn <= 0n) throw new Error('Amount must be positive.');
  return { l, meta, amountIn };
}

async function fetchQuote() {
  const { l, meta, amountIn } = await readTradeInputs();
  const block = await pub.getBlockNumber();
  const quote: any = await curveClient(l.curve).quoteExactInputAtBlock(amountIn, direction === 'sell', block);
  return { l, meta, amountIn, quote };
}

async function showQuote() {
  const box = $('quoteBox');
  try {
    const { meta, quote } = await fetchQuote();
    const inUnit = direction === 'buy' ? 'WETH' : meta.symbol;
    const outUnit = direction === 'buy' ? meta.symbol : 'WETH';
    const outDec = direction === 'buy' ? meta.decimals : 18;
    const inDec = direction === 'buy' ? 18 : meta.decimals;
    const partial = quote.amountLeft > 0n ? ` <b>⚠ partial fill — ${formatUnits(quote.amountLeft, inDec)} ${inUnit} would not fill</b>` : '';
    box.innerHTML = `You receive ≈ <b>${formatUnits(quote.amountOut, outDec)} ${outUnit}</b> · fee ${formatUnits(quote.fee, inDec)} ${inUnit}${partial}`;
  } catch (e: any) {
    box.textContent = `Quote failed: ${e?.shortMessage ?? e?.message ?? e}`;
  }
}

async function executeTrade() {
  const logEl = $('tradeLog');
  const btn = $('tradeBtn') as HTMLButtonElement;
  if (!wallet || !account) { log(logEl, 'Connect your wallet first.', 'err'); return; }
  btn.disabled = true;
  try {
    const { l, meta, amountIn, quote } = await fetchQuote();
    if (quote.amountLeft > 0n) {
      log(logEl, 'Trade would only partially fill (graduation boundary) — aborted. Try a smaller amount.', 'err');
      return;
    }
    const minOut = (quote.amountOut * 9950n) / 10000n; // 0.5% slippage
    const tokenIn = direction === 'buy' ? WETH : l.token;
    // Wrap first if buying and WETH balance is short but ETH covers it.
    if (direction === 'buy') {
      const wethBal = await pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
      if (wethBal < amountIn) {
        const need = amountIn - wethBal;
        const ethBal = await pub.getBalance({ address: account });
        if (ethBal < need) throw new Error('Not enough WETH (and not enough ETH to wrap the shortfall).');
        log(logEl, `Wrapping ${formatUnits(need, 18)} ETH → WETH…`);
        const h = await wallet.sendTransaction({ account, chain, to: WETH, data: encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' }), value: need });
        await pub.waitForTransactionReceipt({ hash: h });
        log(logEl, `Wrapped · tx ${txLink(h)}`, 'ok');
      }
    }
    // Exact approval to the curve if needed.
    const allowance = await pub.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [account, l.curve] });
    if (allowance < amountIn) {
      log(logEl, 'Approving the curve to spend the input token (exact amount)…');
      const h = await wallet.sendTransaction({
        account, chain, to: tokenIn,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [l.curve, amountIn] }),
      });
      await pub.waitForTransactionReceipt({ hash: h });
      log(logEl, `Approved · tx ${txLink(h)}`, 'ok');
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const data = encodeFunctionData({
      abi: ammoraLaunchPoolV4Abi as any, functionName: 'swapExactInput',
      args: [amountIn, minOut, direction === 'sell', false, account, deadline],
    });
    log(logEl, `Swapping on the ${meta.symbol} curve…`);
    const hash = await wallet.sendTransaction({ account, chain, to: l.curve, data });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`Swap reverted: ${hash}`);
    log(logEl, `✅ Trade complete · tx ${txLink(hash)}`, 'ok');
    await renderMarkets();
    await showQuote();
  } catch (e: any) {
    log(logEl, `Error: ${e?.shortMessage ?? e?.message ?? e}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ---------------- Launch ----------------

// Adapted from ammora-examples deriveConfigFromTemplate (MIT).
function deriveConfig(template: any, saleSupply: bigint, threshold: bigint, owner: Address) {
  if (saleSupply <= 0n || threshold <= 0n) throw new RangeError('Sale supply and threshold must be positive.');
  if (template.config.migrationMode !== AmmoraV4MigrationMode.Concentrated) {
    throw new RangeError('Template is not a concentrated-graduation Config.');
  }
  const curve = buildSingleSegmentCurve(template.config.startSqrtPrice, saleSupply, threshold);
  const segment = curve[0];
  if (!segment) throw new Error('Curve construction returned no segment.');
  const range = {
    sqrtPriceX64: segment.upperSqrtPrice,
    sqrtMinPriceX64: segment.lowerSqrtPrice,
    sqrtMaxPriceX64: segment.upperSqrtPrice * 2n,
  };
  const quoteFee = (threshold * BigInt(template.config.migrationQuoteFeeBps)) / 10000n;
  const destination = concentratedDepositQuote(range, { quoteAmount: threshold - quoteFee });
  const vesting = template.config.lockedBaseVesting;
  const lockedBase = vesting.cliffUnlockAmount + vesting.amountPerPeriod * BigInt(vesting.numberOfPeriods);
  const config = {
    ...template.config,
    totalSupply: saleSupply + destination.baseAmount + lockedBase,
    migrationQuoteThreshold: threshold,
    migrationBaseThreshold: destination.baseAmount,
    postMigrationSqrtMinPrice: range.sqrtMinPriceX64,
    postMigrationSqrtMaxPrice: range.sqrtMaxPriceX64,
    postMigrationLiquidity: destination.liquidity,
    partnerRecipient: owner,
    leftoverReceiver: owner,
    liquidityDistribution: { ...template.config.liquidityDistribution, partner: owner },
  };
  assertAmmoraV4Config(config as any, curve as any);
  return { config, curve };
}

async function executeLaunch() {
  const logEl = $('launchLog');
  const btn = $('launchBtn') as HTMLButtonElement;
  if (!wallet || !account) { log(logEl, 'Connect your wallet first.', 'err'); return; }
  btn.disabled = true;
  try {
    const name = ($('lcName') as HTMLInputElement).value.trim();
    const symbol = ($('lcSymbol') as HTMLInputElement).value.trim();
    if (!name || !symbol) throw new Error('Token name and symbol are required.');
    const uriInput = ($('lcUri') as HTMLInputElement).value.trim();
    const metadataURI = uriInput || `https://example.com/${symbol.toLowerCase()}.json`;

    log(logEl, 'Reading the reviewed launch template (Config #6)…');
    const templateBlock = await pub.getBlockNumber();
    const template: any = await getAmmoraV4ConfigAtBlock(pub as any, REGISTRY, TEMPLATE_ID, templateBlock);
    if (!template.enabled) throw new Error('Template Config is disabled.');
    if (template.configHash.toLowerCase() !== TEMPLATE_HASH) {
      throw new Error('Template hash changed since review — aborting. Re-review the template before launching.');
    }
    const decimals = template.config.tokenDecimals as number;
    const saleSupply = parseUnits(($('lcSupply') as HTMLInputElement).value.trim(), decimals);
    const threshold = parseUnits(($('lcThreshold') as HTMLInputElement).value.trim(), 18);
    const firstBuy = parseUnits(($('lcFirstBuy') as HTMLInputElement).value.trim(), 18);
    if (firstBuy <= 0n) throw new Error('First buy must be positive.');

    const { config, curve } = deriveConfig(template, saleSupply, threshold, account);
    // Minimum-received floor: 50% of the start-price estimate for the first buy.
    const sqrtFloat = Number(template.config.startSqrtPrice) / 2 ** 64;
    const estOut = (Number(firstBuy) * 0.99) / (sqrtFloat * sqrtFloat);
    const minBase = estOut > 0 && Number.isFinite(estOut) ? BigInt(Math.floor(estOut * 0.5)) : 1n;

    // Wrap the WETH shortfall for the first buy.
    const wethBal = await pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
    if (wethBal < firstBuy) {
      const need = firstBuy - wethBal;
      const ethBal = await pub.getBalance({ address: account });
      if (ethBal < need) throw new Error('Not enough WETH (and not enough ETH to wrap the shortfall).');
      log(logEl, `Wrapping ${formatUnits(need, 18)} ETH → WETH…`);
      const h = await wallet.sendTransaction({ account, chain, to: WETH, data: encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' }), value: need });
      await pub.waitForTransactionReceipt({ hash: h });
      log(logEl, `Wrapped · tx ${txLink(h)}`, 'ok');
    }

    const parameters = {
      account,
      config, segments: curve,
      launch: { name, symbol, metadataURI, creatorMetadataURI: metadataURI, tokenDecimals: decimals },
      firstBuys: [{ includedQuoteAmountRaw: firstBuy, minimumBaseAmountOutRaw: minBase, allowPartialFill: false, recipient: account }],
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
      allowancePolicy: 'prepare-approval' as const,
      gas: { maxFeePerGasNativeRaw: 100000000n, safetyMarginBps: 2000n },
    };
    const planFresh = async () => createConfigAndPoolWithFirstBuy(pub as any, { ...parameters, blockNumber: await pub.getBlockNumber() } as any);

    log(logEl, 'Planning the atomic launch (Config + token + first buy)…');
    let plan: any = await planFresh();
    if (plan.status === 'APPROVAL_REQUIRED') {
      log(logEl, 'Sending the exact WETH approval to the launch helper…');
      const h = await wallet.sendTransaction({
        account, chain, to: plan.transaction.to, data: plan.transaction.data,
        value: BigInt(plan.transaction.value ?? 0n),
      });
      await pub.waitForTransactionReceipt({ hash: h });
      log(logEl, `Approved · tx ${txLink(h)}`, 'ok');
      plan = await planFresh();
    }
    if (plan.status !== 'READY') throw new Error(`Launch plan not ready: ${plan.status}`);

    log(logEl, `Sending the atomic create (new Config #${plan.expectedConfigId})…`);
    const hash = await wallet.sendTransaction({
      account, chain, to: plan.transaction.to, data: plan.transaction.data,
      value: BigInt(plan.transaction.value ?? 0n),
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`Launch transaction reverted: ${hash}`);
    const created: any = parseAmmoraV4LaunchCreatedReceipt(receipt as any, FACTORY);
    const token = plan.predictedToken as Address;
    const meta = await tokenMeta(token);
    if (meta.symbol.toLowerCase() !== symbol.toLowerCase()) {
      throw new Error(`Created token symbol mismatch (${meta.symbol} vs ${symbol}) — check the explorer before trading.`);
    }
    const entry: Launch = { token, curve: created.curve, name: meta.name, symbol: meta.symbol };
    saveLaunch(entry);
    launches = loadLaunches();
    log(logEl, `🎉 <b>${meta.name} ($${meta.symbol})</b> is live! Token ${addrLink(token)} · Curve ${addrLink(created.curve)} · tx ${txLink(hash)}`, 'ok');
    await renderMarkets();
  } catch (e: any) {
    log(logEl, `Error: ${e?.shortMessage ?? e?.message ?? e}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ---------------- Init ----------------

function setDirection(d: 'buy' | 'sell') {
  direction = d;
  $('dirBuy').classList.toggle('active', d === 'buy');
  $('dirSell').classList.toggle('active', d === 'sell');
  $('amountUnit').textContent = d === 'buy' ? 'WETH' : (selectedLaunch()?.symbol ?? 'TOKEN');
  $('quoteBox').textContent = 'Enter an amount to preview the quote.';
}

$('connectBtn').addEventListener('click', () => connect().catch((e) => alert(e?.message ?? e)));
$('refreshBtn').addEventListener('click', () => renderMarkets());
$('dirBuy').addEventListener('click', () => setDirection('buy'));
$('dirSell').addEventListener('click', () => setDirection('sell'));
$('tradeToken').addEventListener('change', () => { if (direction === 'sell') $('amountUnit').textContent = selectedLaunch().symbol; });
$('quoteBtn').addEventListener('click', () => showQuote());
$('tradeBtn').addEventListener('click', () => executeTrade());
$('launchBtn').addEventListener('click', () => executeLaunch());

renderMarkets().catch((e) => {
  $('marketList').innerHTML = `<p class="muted">Could not reach the GIWA Sepolia RPC: ${e?.message ?? e}</p>`;
});
