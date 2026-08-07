/**
 * Product identity, in one place.
 *
 * The name lives here rather than scattered through the UI so renaming is a
 * one-file change instead of a repo-wide grep — which matters, because the name
 * has already changed once.
 *
 * A note on why it is not "Polybet", since that will come up again: the Chrome
 * Web Store bans extensions that facilitate real-money prediction market
 * trading and carves out an exception only for simulators that clearly indicate
 * no real money is involved. Putting "bet" in the product name argues against
 * that exception in the first place a reviewer looks. "Paper Predictions" says
 * exactly what the product is — paper trading, on prediction markets — and
 * contains no gambling word at all.
 */

export const BRAND = {
  name: 'Paper Predictions',
  tagline: 'Paper-trade real prediction markets',
  /** Shown wherever a number could otherwise be mistaken for real money. */
  currencySymbol: 'P$',
  /** Never dismissible. Required on every price, position and order surface. */
  disclaimer: 'SIMULATED · NO REAL MONEY',
  /** Short form, for the overlay's cramped title bar. */
  disclaimerShort: 'SIM · NO REAL MONEY',
} as const;
