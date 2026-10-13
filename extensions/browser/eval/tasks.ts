export interface EvalTask {
  id: string;
  prompt: string;
  /** A cheap automatic signal; the answers are still read by a person. */
  expect?: RegExp;
}

export const tasks: EvalTask[] = [
  {
    id: "finn-glc",
    prompt:
      "Find Mercedes-Benz GLC cars of model year 2027 for sale in the Oslo area on finn.no. List up to 5, cheapest first, with price, mileage, location and a link to each listing.",
    expect: /finn\.no\/mobility\/item\/\d+/,
  },
  {
    id: "finn-rental",
    prompt:
      "On finn.no, find apartments for rent on Grünerløkka in Oslo with at least two bedrooms and a monthly rent under 25 000 kr. Give me three, with rent, size and a link to each.",
    expect: /finn\.no\/(realestate|lettings|eiendom)[^\s)]*\d+/,
  },
  {
    id: "entur-train",
    prompt:
      "Find train departures from Oslo S to Lillehammer tomorrow between 07:00 and 10:00, using entur.no. List departure and arrival times and whether a change is needed.",
    expect: /\b0[7-9][:.]\d\d\b/,
  },
  {
    id: "prisjakt-headphones",
    prompt:
      "On prisjakt.no, what is the lowest current price for Sony WH-1000XM6 headphones, and which shop has it?",
    expect: /\d[\d  ]*\s?(kr|,-)/,
  },
  {
    id: "yr-tromso",
    prompt:
      "Using yr.no, what is the weather forecast for Tromsø tomorrow: temperature range and precipitation?",
    expect: /-?\d+\s?°/,
  },
  {
    id: "wiki-bodo",
    prompt:
      "On no.wikipedia.org, how many inhabitants does Bodø municipality have according to its article?",
    expect: /\d{2}[\d  ,.]{3,}/,
  },
];
