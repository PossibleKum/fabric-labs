'use strict';

/**
 * Supply Chain Tracking Chaincode (Hyperledger Fabric, Node.js)
 *
 * Lifecycle of a product:
 *
 *   MANUFACTURED --ship--> IN_TRANSIT --receive--> RECEIVED --ship--> IN_TRANSIT ...
 *                                                     |
 *                                                     +--sell (retailer)--> SOLD
 *
 * Each product is one world-state asset keyed by productId. Every step is also
 * appended to the product's `events` array, and Fabric's key history
 * (getHistoryForKey) gives the full tamper-proof trail of all versions.
 *
 * Roles come from the caller's certificate attribute `role`:
 *   manufacturer | distributor | retailer
 * The caller's identity (`userId` attribute) is the product owner.
 */

const { Contract } = require('fabric-contract-api');

const STATUS = {
    MANUFACTURED: 'MANUFACTURED',
    IN_TRANSIT: 'IN_TRANSIT',
    RECEIVED: 'RECEIVED',
    SOLD: 'SOLD',
};

class SupplyChainContract extends Contract {
    constructor() {
        super('SupplyChainContract');
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    _now(ctx) {
        const ts = ctx.stub.getTxTimestamp();
        return new Date(ts.seconds.low * 1000).toISOString();
    }

    _caller(ctx) {
        const id = ctx.clientIdentity;
        return {
            mspId: id.getMSPID(),
            role: id.getAttributeValue('role') || 'unknown',
            userId: id.getAttributeValue('userId') || id.getID(),
        };
    }

    _require(ctx, roles) {
        const caller = this._caller(ctx);
        if (!roles.includes(caller.role)) {
            throw new Error(
                `Access denied: role '${caller.role}' not permitted. Allowed: ${roles.join(', ')}`
            );
        }
        return caller;
    }

    async _load(ctx, productId) {
        const data = await ctx.stub.getState(productId);
        if (!data || data.length === 0) {
            throw new Error(`Product ${productId} not found`);
        }
        return JSON.parse(data.toString());
    }

    async _save(ctx, product) {
        await ctx.stub.putState(product.productId, Buffer.from(JSON.stringify(product)));
    }

    _addEvent(ctx, product, type, caller, location, note) {
        product.events.push({
            type,
            actor: caller.userId,
            role: caller.role,
            msp: caller.mspId,
            location: location || null,
            note: note || null,
            txId: ctx.stub.getTxID(),
            timestamp: this._now(ctx),
        });
    }

    async _collect(iterator, filter) {
        const results = [];
        for await (const res of iterator) {
            const value = JSON.parse(res.value.toString());
            if (!filter || filter(value)) {
                results.push(value);
            }
        }
        return results;
    }

    // ------------------------------------------------------------------
    // Transactions
    // ------------------------------------------------------------------

    /** Manufacturer registers a new product / batch on the ledger. */
    async createProduct(ctx, productId, name, batchNo, origin) {
        const caller = this._require(ctx, ['manufacturer']);
        const existing = await ctx.stub.getState(productId);
        if (existing && existing.length > 0) {
            throw new Error(`Product ${productId} already exists`);
        }
        const product = {
            docType: 'product',
            productId,
            name,
            batchNo,
            origin,
            manufacturer: caller.userId,
            owner: caller.userId,
            pendingOwner: null,
            status: STATUS.MANUFACTURED,
            location: origin,
            createdAt: this._now(ctx),
            events: [],
        };
        this._addEvent(ctx, product, 'CREATED', caller, origin, `Batch ${batchNo}`);
        await this._save(ctx, product);
        return JSON.stringify(product);
    }

    /** Current owner hands the product to a carrier / next party. */
    async shipProduct(ctx, productId, toUserId, carrier, location) {
        const caller = this._require(ctx, ['manufacturer', 'distributor', 'retailer']);
        const product = await this._load(ctx, productId);

        if (product.owner !== caller.userId) {
            throw new Error(`Only the current owner (${product.owner}) can ship this product`);
        }
        if (![STATUS.MANUFACTURED, STATUS.RECEIVED].includes(product.status)) {
            throw new Error(`Cannot ship a product with status ${product.status}`);
        }
        if (toUserId === caller.userId) {
            throw new Error('Cannot ship to yourself');
        }

        product.status = STATUS.IN_TRANSIT;
        product.pendingOwner = toUserId;
        product.location = location;
        this._addEvent(ctx, product, 'SHIPPED', caller, location, `To ${toUserId} via ${carrier}`);
        await this._save(ctx, product);
        return JSON.stringify(product);
    }

    /** The intended recipient confirms receipt; ownership transfers here. */
    async receiveProduct(ctx, productId, location) {
        const caller = this._require(ctx, ['distributor', 'retailer']);
        const product = await this._load(ctx, productId);

        if (product.status !== STATUS.IN_TRANSIT) {
            throw new Error(`Product is not in transit (status ${product.status})`);
        }
        if (product.pendingOwner !== caller.userId) {
            throw new Error(`Only the intended recipient (${product.pendingOwner}) can receive it`);
        }

        const previousOwner = product.owner;
        product.owner = caller.userId;
        product.pendingOwner = null;
        product.status = STATUS.RECEIVED;
        product.location = location;
        this._addEvent(ctx, product, 'RECEIVED', caller, location, `From ${previousOwner}`);
        await this._save(ctx, product);
        return JSON.stringify(product);
    }

    /** Owner or intended recipient logs a checkpoint (e.g. warehouse scan, temperature note). */
    async addTrackingEvent(ctx, productId, location, note) {
        const caller = this._require(ctx, ['manufacturer', 'distributor', 'retailer']);
        const product = await this._load(ctx, productId);

        if (product.status === STATUS.SOLD) {
            throw new Error('Product already sold');
        }
        if (caller.userId !== product.owner && caller.userId !== product.pendingOwner) {
            throw new Error('Only the owner or the intended recipient can add tracking events');
        }
        product.location = location;
        this._addEvent(ctx, product, 'CHECKPOINT', caller, location, note);
        await this._save(ctx, product);
        return JSON.stringify(product);
    }

    /** Retailer sells the product to the end customer. */
    async sellProduct(ctx, productId, customerRef) {
        const caller = this._require(ctx, ['retailer']);
        const product = await this._load(ctx, productId);

        if (product.owner !== caller.userId) {
            throw new Error(`Only the current owner (${product.owner}) can sell this product`);
        }
        if (product.status !== STATUS.RECEIVED) {
            throw new Error(`Cannot sell a product with status ${product.status}`);
        }
        product.status = STATUS.SOLD;
        product.soldTo = customerRef;
        this._addEvent(ctx, product, 'SOLD', caller, product.location, `Customer ref ${customerRef}`);
        await this._save(ctx, product);
        return JSON.stringify(product);
    }

    // ------------------------------------------------------------------
    // Queries
    // ------------------------------------------------------------------

    async getProduct(ctx, productId) {
        return JSON.stringify(await this._load(ctx, productId));
    }

    /** Every version of the product on the ledger (provenance / audit trail). */
    async getProductHistory(ctx, productId) {
        const iterator = await ctx.stub.getHistoryForKey(productId);
        const out = [];
        for await (const mod of iterator) {
            const value = mod.value && mod.value.length ? JSON.parse(mod.value.toString()) : null;
            out.push({
                txId: mod.txId,
                timestamp: new Date(mod.timestamp.seconds.low * 1000).toISOString(),
                isDelete: mod.isDelete,
                status: value ? value.status : null,
                owner: value ? value.owner : null,
                location: value ? value.location : null,
            });
        }
        return JSON.stringify(out);
    }

    async getAllProducts(ctx) {
        const iterator = await ctx.stub.getStateByRange('', '');
        return JSON.stringify(await this._collect(iterator, v => v.docType === 'product'));
    }

    async getProductsByStatus(ctx, status) {
        const iterator = await ctx.stub.getStateByRange('', '');
        return JSON.stringify(
            await this._collect(iterator, v => v.docType === 'product' && v.status === status)
        );
    }

    async getProductsByOwner(ctx, owner) {
        const iterator = await ctx.stub.getStateByRange('', '');
        return JSON.stringify(
            await this._collect(iterator, v => v.docType === 'product' && v.owner === owner)
        );
    }
}

module.exports = SupplyChainContract;
