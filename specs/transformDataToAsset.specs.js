import should from './setup';
import Sut from './../src/transformDataToAsset';

describe('src/transformDataToAsset', function () {
	describe('given an object of asset data', () => {
		let assetData, actual, inputDate1, inputDate2;
		beforeEach(() => {
			actual = undefined;
			inputDate1 = new Date();
			inputDate2 = new Date();
			assetData = {
				Member: 'Member:20',
				Actuals: [
					{
						idref: 'Actual:10001',
						Value: 2.5,
						Date: inputDate1
					},
					{
						idref: 'Actual:10002',
						Value: 5.2,
						Date: inputDate2
					}
				]
			};
		});

		describe('when transforming the asset data to something acceptable to the V1 Server instance', () => {
			beforeEach(() => {
				actual = Sut(assetData);
			});

			it('it should return an object with Attributes values', () => {
				should.exist(actual.Attributes);
			});

			it('it should transform keys with non-array values to single-relation properties on the output object', () => {
				actual.Attributes.Member.should.eql({
					value: 'Member:20'
				});
			});

			it('it should transform keys with array values to a multi-relation asset attribute property on the output object', () => {
				actual.Attributes.Actuals.should.eql({
					_type: 'Relation',
					value: [
						{
							idref: 'Actual:10001',
							Value: 2.5,
							Date: inputDate1
						},
						{
							idref: 'Actual:10002',
							Value: 5.2,
							Date: inputDate2
						}
					]
				});
			});
		});
	});
});
