const orderCache = require("../model/orderCache");
const resolverAbi = require("../abi/resolver.json");
const factoryAbi = require("../abi/factory.json");
const lopAbi = require("../abi/lop.json");
const { b58cdecode, prefix } = require("@taquito/utils");
const { sha256 } = require('@noble/hashes/sha2');
const { concatBytes } = require('@noble/hashes/utils');
const { ethers } = require("ethers");

const SALT = '0x31696e63685f63726f73735f636861696e5f7631'

function packTezos(tzAddress) {
    const payload = b58cdecode(tzAddress, prefix.tz1);
    return Buffer.from([0x05, 0x0a, 0x00, 0x0d, ...payload])
}


function tezoshash32(tzAddress) {
    const packed = packTezos(tzAddress);
    const saltBytes = Buffer.from(SALT.slice(2), 'hex');
    // Convert Buffers to Uint8Array for concatBytes
    const packedUint8 = new Uint8Array(packed);
    const saltUint8 = new Uint8Array(saltBytes);
    const hash = concatBytes(packedUint8, saltUint8);
    return ethers.hexlify(sha256(hash));
}

function sha256bytes(hex) {
    return ethers.sha256(ethers.getBytes(hex))
}

function encodeTimelocks({ withdrawal, publicWithdrawal, cancellation, publicCancellation, deployedAt }) {
    return (
        (BigInt(withdrawal) << 152n) |
        (BigInt(publicWithdrawal) << 112n) |
        (BigInt(cancellation) << 72n) |
        (BigInt(publicCancellation) << 32n) |
        BigInt(deployedAt)
    );
}

class OrderProcessor {
    constructor(tezos) {
        this.tezos = tezos;
        this.processing = false;
    }

    async processNextOrder() {
        // Skip if already processing an order
        if (this.processing) {
            return;
        }
        let order;
        try {
            this.processing = true;

            // Get next unprocessed order from cache
            order = orderCache.getAllOrders()[0];
            if (!order) {
                console.log("💤 No orders to process");
                return;
            }

            console.log(`⚙️ Processing order: ${order}`);

            // Update order status to PROCESSING
            orderCache.updateOrderStatus(order._id, "PROCESSING");

            const contract = await this.tezos.contract.at(
                process.env.DUTCH_AUCTION_CONTRACT_ADDRESS
            );

            // ------------------------------------------
            // 1. get taking amount for predefined making amount
            const predefinedMakingAmount = Math.floor(Number(order.srcQty) * 1e6);
            let takingAmountArgs = []
            if (order.destinationChain == "Tezos") {
                // single fill
                takingAmountArgs = [
                    order._id, // auction_id
                    null, // current_gas_price (optional, can be null)
                    predefinedMakingAmount, // making_amount (integer)
                ];
                console.log("📝 Making args:", takingAmountArgs);
            }

            if (order.srcChain == "Tezos") {
                // double fill
            }

            // const getTakingAmountOp = await contract.methods.get_taking_amount(...takingAmountArgs).send();
            // await getTakingAmountOp.confirmation();
            // console.log("✔️ Operation hash:", getTakingAmountOp.hash);

            // ------------------------------------------
            // 2. Make auction fill record using the agreed making amount
            let recordFillArgs = []
            if (order.destinationChain == "Tezos") {
                // single fill
                recordFillArgs = [
                    order._id, // auction_id
                    predefinedMakingAmount, // filled_amount (integer)
                    process.env.RESOLVER_ADDRESS, // resolver_address
                ];
                console.log("📝 Making args:", recordFillArgs);
            }

            if (order.srcChain == "Tezos") {
                // double fill
            }

            // const recordFillOp = await contract.methods.record_fill(...recordFillArgs).send();
            // await recordFillOp.confirmation();
            // console.log("✔️ Operation hash:", recordFillOp.hash);


            // ------------------------------------------
            // 3. Read the event emitted from the dutch auction contract via tzkt indexer
            const eventRequestOptions = {
                method: "GET",
                redirect: "follow"
            };
            const response = await fetch(`https://api.ghostnet.tzkt.io/v1/contracts/events?contract=${process.env.DUTCH_AUCTION_CONTRACT_ADDRESS}&tag=taking_amount`, eventRequestOptions)
            const eventData = await response.json();
            const event = eventData.filter(event => event.payload.auction_id === order._id)[0];

            console.log("📜 Event data:", event);

            // ------------------------------------------
            // 4. Add the active fill record in DB

            const fillHeaders = new Headers();
            fillHeaders.append("Content-Type", "application/json");

            const rawBody = JSON.stringify({
                "hash": order.hashlock,
                "status": "OPEN",
                "orderId": order._id,
                "takerSourceChainAddress": process.env.RESOLVER_EVM_ADDRESS,
                "takerDestChainAddress": process.env.RESOLVER_ADDRESS,
                "safetyDeposit": "5000000",
                "makingQty": Number(event.payload.making_amount) / 1e6,
                "takingQty": Number(event.payload.taking_amount) / 1e6,
            });

            const fillRequestOptions = {
                method: "POST",
                headers: fillHeaders,
                body: rawBody,
                redirect: "follow"
            };

            const fillResponse = await fetch(`${process.env.RELAYER_BASE_URL}/fusion-plus/relayer/v1.0/submit/secret`, fillRequestOptions)
            const fillData = await fillResponse.json();
            console.log("📥 Fill record response:", fillData);


            // ------------------------------------------
            // 5. Make call to escrow hub on src chain
            const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL);
            const wallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY, provider);

            const TZ_MAKER_HASH = tezoshash32(order.makerDestinationChainAddress)
            const TZ_RES_HASH = tezoshash32(process.env.RESOLVER_ADDRESS)
            const TOKEN_SEPOLIA = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'

            /* timeLocks - unix seconds */
            const nowSec = Math.floor(Date.now() / 1e3);
            const WITHDRAWAL = nowSec + 1800;  // +30 min
            const PUBLIC_WITHDRAW = nowSec + 2700;
            const CANCELLATION = nowSec + 3600;
            const PUBLIC_CANCEL = nowSec + 4500;


            const timelocks = encodeTimelocks({
                withdrawal: WITHDRAWAL,
                publicWithdrawal: PUBLIC_WITHDRAW,
                cancellation: CANCELLATION,
                publicCancellation: PUBLIC_CANCEL,
                deployedAt: 0
            });

            const immutables = {
                orderHash: order.orderHash,
                hashlock: order.hashlock,
                maker: TZ_MAKER_HASH,
                taker: TZ_RES_HASH,
                token: TOKEN_SEPOLIA,
                amount: ethers.parseUnits(order.srcQty, 6),
                safetyDeposit: ethers.parseEther('0.1'),
                timelocks: timelocks
            };

            const escrowOrder = {
                salt: ethers.hexlify(ethers.randomBytes(32)),
                makerAsset: TOKEN_SEPOLIA,
                takerAsset: ethers.ZeroAddress,        // ETH sentinel
                maker: makerSourceChainAddress,
                receiver: TZ_RES_HASH,
                // allowedSender: process.env.RESOLVER_EVM_ADDRESS,          // ← bypass maker sig
                makingAmount: ethers.parseUnits(order.srcQty, 6),
                takingAmount: 0,
                makerTraits: ethers.getBigInt(0)
            };

            const r = ethers.ZeroHash;       // '0x' + 64 zeroes (bytes32)
            const vs = ethers.ZeroHash;

            const signer = new ethers.Wallet(process.env.EVM_PRIVATE_KEY, provider);
            const Resolver = new ethers.Contract(process.env.RESOLVER_CONTRACT_ADDRESS, resolverAbi, signer);

            console.log("Calling deploySrc...");
            console.log("▶️ deploySrc args:", {
                immutables,
                escrowOrder,
                r,
                vs,
                fillAmount: ethers.parseUnits(order.srcQty, 6),
                zero: ethers.getBigInt(0),
                extraArgs: "0x",
                value: ethers.parseEther('0.1')
            });

            const tx = await Resolver.deploySrc(
                immutables,
                escrowOrder,
                r,
                vs,
                ethers.parseUnits(order.srcQty, 6),                    // fill amount (full Lot)
                ethers.getBigInt(0),
                "0x",                        // extra args
                { value: ethers.parseEther('0.1') }
            );

            console.log("tx hash:", tx.hash);
            await tx.wait();
            console.log("✓ EscrowSrc deployed & funded.");

            // 6. Make call to escrow hub on dest chain
            const args = [
                Number(event.payload.taking_amount) / 1e6,                  // nat
                order.hashlock,           // same as source escrow
                false,                   // bool (true/false) - pass false 
                TZ_MAKER_HASH,            // address 
                order.makerSourceChainAddress,           // bytes (e.g. '0x...')
                safetyDeposit,           // mutez (integer)
                TZ_RES_HASH,            // address
                process.env.RESOLVER_EVM_ADDRESS,           // bytes (e.g. '0x...')
                [                        // timelocks as an array of 4 timestamps (seconds since epoch)
                    CANCELLATION,  //now+1yr
                    PUBLIC_CANCEL,
                    PUBLIC_WITHDRAW,
                    WITHDRAWAL
                ],
                0,           // address
                0                  // nat
            ];

            const tezosContract = await tezos.contract.at(process.env.TEZOS_ESCROW_FACTORY_ADDRESS);

            const op = await tezosContract.methods.create_escrow(...args).send();
            await op.confirmation();
            console.log('✔ Escrow created, op hash:', op.hash);

            // 7. hit the relayer API to make the fill status 'ACTIVE'
            const activeFillHeaders = new Headers();
            activeFillHeaders.append("Content-Type", "application/json");

            const rawActiveFillBody = JSON.stringify({
                "hash": order.hashlock,
                "status": "ACTIVE",
                "orderId": order._id,
                "takerSourceChainAddress": process.env.RESOLVER_EVM_ADDRESS,
                "takerDestChainAddress": process.env.RESOLVER_ADDRESS,
                "safetyDeposit": "5000000",
                "makingQty": Number(event.payload.making_amount) / 1e6,
                "takingQty": Number(event.payload.taking_amount) / 1e6,
            });

            const activeFillRequestOptions = {
                method: "POST",
                headers: activeFillHeaders,
                body: rawActiveFillBody,
                redirect: "follow"
            };

            const activeFillResponse = await fetch(`${process.env.RELAYER_BASE_URL}/fusion-plus/relayer/v1.0/submit/secret`, activeFillRequestOptions)
            const activeFillData = await activeFillResponse.json();
            console.log("📥 Fill record response:", activeFillData);

            // Mark as completed
            orderCache.updateOrderStatus(order._id, 'COMPLETED');
            console.log(`✅ Completed processing order: ${order._id}`);
        } catch (error) {
            console.error("❌ Error processing order:", error);
            if (order) {
                orderCache.updateOrderStatus(order._id, "FAILED", error.message);
            }
        } finally {
            this.processing = false;
        }
    }
}

module.exports = OrderProcessor;
