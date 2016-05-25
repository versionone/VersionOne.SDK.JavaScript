export const InvalidOidToken = class extends Error {
    constructor(message) {
        this.name = 'InvalidOidToken';
        this.message = message || '';
    }
};

export default class {
    constructor(oidToken) {
        try {
            const oidParts = oidToken.split(':');
            this.type = oidParts[0];
            this.idNumber = parseInt(oidParts[1], 10);
        } catch (error) {
            throw new InvalidOidToken(error.message);
        }
    }

    get assetType() {
        return this.type;
    }

    get number() {
        return this.idNumber;
    }

    toString() {
        return `${this.assetType}:${this.number}`;
    }
}