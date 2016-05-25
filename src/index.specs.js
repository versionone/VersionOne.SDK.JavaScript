import * as Sut from './index';
import V1Meta from './V1Meta';
import * as Oid from './Oid';

describe('when loading the module', () => {
    it('it should export V1Meta', () => {
        Sut.V1Meta.should.equal(V1Meta);
    });

    it('it should export Oid', () => {
        Sut.Oid.should.equal(Oid);
    });
});
