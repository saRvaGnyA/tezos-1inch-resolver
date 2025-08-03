const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const { TezosToolkit } = require('@taquito/taquito');
const { InMemorySigner } = require('@taquito/signer');

const Order = require('../model/order');
const Fills = require('../model/fills');
const orderCache = require('../model/orderCache');
const OrderProcessor = require('../service/orderProcessor');

const app = express();

const tezos = new TezosToolkit('https://rpc.ghostnet.teztnets.com');
const orderProcessor = new OrderProcessor(tezos);

// DB Connection 
let isConnected = false;
async function connectDBAndTezos() {
    console.log('⏳ Trying DB connect…');
    if (!isConnected) {

        try {
            await mongoose.connect(process.env.MONGODB_URI, {
                useNewUrlParser: true,
                useUnifiedTopology: true
            });
            console.log('✅ DB connect successful');
        } catch (err) {
            console.error('❌ DB connect failed', err);
            return res.status(500).send('DB error');
        }
        isConnected = true;
        console.log('🔗 Mongo connected');
    }
    console.log('⏳ Trying to set provider…');
    tezos.setProvider({ signer: new InMemorySigner(process.env.IN_MEMORY_PRIVATE_KEY) });
}

app.use(cors());
app.use(express.json());

// Set up polling interval (10 seconds)
const POLLING_INTERVAL = 10000; // 10 seconds in milliseconds
const LOOKBEHIND_INTERVAL = 600000000000;

// Root health‑check routes
app.get('/', (req, res) => {
    console.log('🏓 received GET /');
    res.json({ ok: true, message: 'pong' });
});

app.get('/health-check', (req, res) => {
    res.json({ healthy: true, message: 'API is healthy' });
});


// Function to fetch active bidirectional orders
async function fetchActiveOrders(src, dest) {
    try {
        const requestOptions = {
            method: "GET",
            redirect: "follow"
        };

        const response = await fetch(`${process.env.RELAYER_BASE_URL}/fusion-plus/orders/v1.0/order/active?srcChain=${src}&dstChain=${dest}`, requestOptions)
        const data = await response.json();
        console.log(`📊 Fetched active ${src} to ${dest} orders:`, data.length);

        // Find orders created in the last polling interval
        if (Array.isArray(data) && data.length > 0) {
            const now = new Date();
            const pollingWindowStart = new Date(now - LOOKBEHIND_INTERVAL);

            const newOrders = data.filter(order => {
                const orderCreatedAt = new Date(order.createdAt);
                return orderCreatedAt >= pollingWindowStart && orderCreatedAt <= now;
            });

            if (newOrders.length > 0) {
                // Track the first new order
                const orderIdToTrack = "688e3e89358d4ca469ded0c4";
                const newOrdersFiltered = newOrders.filter(order =>
                    order._id.toString() === orderIdToTrack.toString()
                );
                // const orderToTrack = newOrders[0];
                const orderToTrack = newOrdersFiltered[0];
                try {
                    const trackedOrder = orderCache.trackOrder(orderToTrack);
                    console.log('🔄 Now tracking new order created at', orderToTrack.createdAt);
                    console.log('Order details:', trackedOrder._id);
                } catch (err) {
                    console.error('❌ Failed to track order:', err.message);
                }
            } else {
                console.log('📝 No new orders in the last polling interval');
            }
        }
    } catch (error) {
        console.error('❌ Error fetching active orders:', error);
    }
}



// Start the server
const PORT = process.env.PORT || 3000;

const startServer = async () => {
    await connectDBAndTezos();

    // Start polling for active orders
    setInterval(() => { fetchActiveOrders('Polygon', 'Tezos') }, POLLING_INTERVAL);
    setInterval(() => { fetchActiveOrders('Tezos', 'Polygon') }, POLLING_INTERVAL);
    console.log('🔄 Started polling for active orders');

    // Start order processing loop
    setInterval(() => { orderProcessor.processNextOrder() }, 5000);
    console.log('🔄 Started order processor');

    // Trigger first fetch immediately
    fetchActiveOrders('Polygon', 'Tezos');
    fetchActiveOrders('Tezos', 'Polygon');

    app.listen(PORT, () => {
        console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
};

startServer().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
});