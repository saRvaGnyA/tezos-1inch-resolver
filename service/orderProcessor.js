const orderCache = require("../model/orderCache");

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

        try {
            this.processing = true;

            // Get next unprocessed order from cache
            const order = orderCache.getAllOrders()[0];
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

            const getTakingAmountOp = await contract.methods.get_taking_amount(...takingAmountArgs).send();
            await getTakingAmountOp.confirmation();
            console.log("✔️ Operation hash:", getTakingAmountOp.hash);

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

            const recordFillOp = await contract.methods.record_fill(...recordFillArgs).send();
            await recordFillOp.confirmation();
            console.log("✔️ Operation hash:", recordFillOp.hash);

            // 3. Read the event emitted from the dutch auction contract via tzkt indexer
            const requestOptions = {
                method: "GET",
                redirect: "follow"
            };
            const response = await fetch(`https://api.ghostnet.tzkt.io/v1/contracts/events?contract=${process.env.DUTCH_AUCTION_CONTRACT_ADDRESS}&tag=taking_amount`, requestOptions)
            const data = await response.json();
            const event = data.filter(event => event.payload.auction_id === order._id)[0];

            console.log("📜 Event data:", event);

            // 4. Make call to escrow hub on both src and dest chains


            // 3. hit the relayer API to add the order fill

            // Mark as completed
            // orderCache.updateOrderStatus(order._id, 'COMPLETED');
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
