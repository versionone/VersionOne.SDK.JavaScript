import Sut, {InvalidOidToken} from './Oid';

describe('src/Oid', function() {
    beforeEach(() => {
        this.actual = undefined;
    });
    describe('given a valid Oid Token', () => {
        beforeEach(() => {
            this.oidToken = 'Member:20';
        });
        describe('when creating an Oid from the Oid Token', () => {
            beforeEach(() => {
                this.actual = new Sut(this.oidToken);
            });

            it('it should return an Oid with an asset type', () => {
                this.actual.assetType.should.equal('Member');
            });

            it('it should return a read-only asset type property', () => {
                (() => this.actual.assetType = 'Story').should.throw;
            });

            it('it should return an Oid with a ID number', () => {
                this.actual.number.should.equal(20);
            });

            it('it should return a read-only ID number property', () => {
                (() => this.actual.number = 25).should.throw;
            });
        });

        describe('when toString is called', () => {
            beforeEach(() => {
                this.actual = new Sut(this.oidToken).toString();
            });

            it('it should return an Oid Token for the Oid', () => {
                this.actual.should.equal('Member:20');
            });
        });
    });

    describe('given an invalid Oid Token', () => {
        beforeEach(() => {
            this.oidToken = 'Member:Username';
        });
        describe('when creating an Oid from the Oid token', () => {
            beforeEach(() => {
                (() => this.actual = new Sut(this.oidToken)).should.throw(InvalidOidToken);
            });
        });
    });
});
