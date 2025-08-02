// In-memory cache for tracking order lifecycles
class OrderCache {
    constructor() {
        this.activeOrders = new Map();
        this.orderStatus = {
            RECEIVED: 'RECEIVED',           // Just received from the API
            PROCESSING: 'PROCESSING',       // Processing the order
            COMPLETED: 'COMPLETED',         // Order has been successfully processed
            FAILED: 'FAILED',              // Order processing failed
            EXPIRED: 'EXPIRED'             // Order timelock expired
        };
    }

    /**
     * Add or update an order in the cache
     * @param {Object} order - The order object from the API
     * @returns {Object} The cached order with additional tracking information
     */
    trackOrder(order) {
        if (!order?._id) {
            throw new Error('Invalid order: missing _id');
        }

        const cachedOrder = this.activeOrders.get(order._id);
        if (cachedOrder) {
            return cachedOrder;
        }

        // Initialize new order tracking
        const orderTracking = {
            ...order,
            trackingStatus: this.orderStatus.RECEIVED,
            trackingStartTime: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            processingHistory: [{
                status: this.orderStatus.RECEIVED,
                timestamp: new Date().toISOString(),
                details: 'Order received from API'
            }]
        };

        this.activeOrders.set(order._id, orderTracking);
        console.log(`🎯 Started tracking order: ${order._id}`);
        return orderTracking;
    }

    /**
     * Update the status of an order
     * @param {string} orderId - The order ID
     * @param {string} newStatus - The new status
     * @param {string} details - Additional details about the status update
     * @returns {Object} The updated order tracking object
     */
    updateOrderStatus(orderId, newStatus, details = '') {
        const order = this.activeOrders.get(orderId);
        if (!order) {
            throw new Error(`Order not found in cache: ${orderId}`);
        }

        if (!Object.values(this.orderStatus).includes(newStatus)) {
            throw new Error(`Invalid status: ${newStatus}`);
        }

        order.trackingStatus = newStatus;
        order.lastUpdated = new Date().toISOString();
        order.processingHistory.push({
            status: newStatus,
            timestamp: new Date().toISOString(),
            details
        });

        this.activeOrders.set(orderId, order);
        console.log(`📝 Updated order ${orderId} status to ${newStatus}`);
        return order;
    }

    /**
     * Get an order from the cache
     * @param {string} orderId - The order ID
     * @returns {Object} The cached order tracking object
     */
    getOrder(orderId) {
        return this.activeOrders.get(orderId);
    }

    /**
     * Get all orders from the cache
     * @returns {Object[]} Array of all cached orders
     */
    getAllOrders() {
        return Array.from(this.activeOrders.values());
    }

    /**
     * Remove an order from the cache
     * @param {string} orderId - The order ID
     */
    removeOrder(orderId) {
        this.activeOrders.delete(orderId);
        console.log(`🗑️ Removed order from tracking: ${orderId}`);
    }

    /**
     * Check if an order exists in the cache
     * @param {string} orderId - The order ID
     * @returns {boolean}
     */
    hasOrder(orderId) {
        return this.activeOrders.has(orderId);
    }
}

// Export a singleton instance
module.exports = new OrderCache();
