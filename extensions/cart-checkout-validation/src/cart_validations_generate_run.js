// @ts-check

/**
 * @param {any} input
 * @returns {{ operations: Array<any> }}
 */
export function run(input) {
  const NO_ERRORS = { operations: [] };

  // Only validate at checkout steps, not on the cart page
  const step = input.buyerJourney?.step;
  if (step === "CART_INTERACTION") return NO_ERRORS;

  const metafieldValue = input.cart.buyerIdentity?.customer?.discountData?.value;
  if (!metafieldValue) return NO_ERRORS;

  let data;
  try {
    data = JSON.parse(metafieldValue);
  } catch {
    return NO_ERRORS;
  }

  const minimumCents = data.m;
  if (!minimumCents || minimumCents <= 0) return NO_ERRORS;

  const subtotalCents = Math.round(
    parseFloat(input.cart.cost.subtotalAmount.amount) * 100
  );

  if (subtotalCents >= minimumCents) return NO_ERRORS;

  const minimumStr = (minimumCents / 100).toFixed(2);
  const neededStr = ((minimumCents - subtotalCents) / 100).toFixed(2);
  const currency = input.cart.cost.subtotalAmount.currencyCode;

  const minFmt = currency + " " + minimumStr;
  const neededFmt = currency + " " + neededStr;

  const template = (data.msg && data.msg.trim())
    ? data.msg
    : "Minimum order is {min}. Add {required} more to proceed.";

  const message = template
    .split("{min}").join(minFmt)
    .split("{required}").join(neededFmt)
    .split("{needed}").join(neededFmt);

  return {
    operations: [
      {
        validationAdd: {
          errors: [
            {
              message,
              target: "$.cart",
            },
          ],
        },
      },
    ],
  };
}
