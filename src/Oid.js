export const InvalidOidToken = class {
    constructor(message) {
        this.name = this.constructor.name;
        this.message = message;
        if (typeof Error.captureStackTrace === 'function') {
            Error.captureStackTrace(this, this.constructor);
        } else {
            this.stack = (new Error(message)).stack;
        }
    }
};
InvalidOidToken.prototype = Object.create(Error.prototype);

export default class {
    constructor(oidToken) {
        const oidParts = oidToken.split(':');
        if (/[1-9][0-9]*/.exec(oidParts[1]) === null) {
            throw new InvalidOidToken(oidToken);
        }
        this.type = oidParts[0];
        this.idNumber = parseInt(oidParts[1], 10);
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
