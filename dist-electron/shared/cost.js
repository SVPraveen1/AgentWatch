"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultCostProvider = exports.NullCostProvider = void 0;
class NullCostProvider {
    id = 'null-cost-provider';
    estimateCost(_input) {
        return null;
    }
}
exports.NullCostProvider = NullCostProvider;
exports.defaultCostProvider = new NullCostProvider();
