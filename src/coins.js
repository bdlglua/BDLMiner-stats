// Fixed labels only: reports never provide a display name or arbitrary chain.
export const COINS = Object.freeze(["BTC", "BCH", "BSV", "XEC", "DGB", "PPC"]);
export const validCoin = (value) => COINS.includes(value);
// Missing fields predate coin selection and default to BTC.
export const coinGroup = (value) => validCoin(value) ? value : "BTC";
