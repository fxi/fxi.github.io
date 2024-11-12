export type Publication = {
  title: string;
  authors: string[];
  year: number;
  month: number;
  journal: string;
  volume: string;
  doi: string;
  pages?: string;
};

export const publications: Publication[] = [
  {
    title: "Impacts of climate change on aquatic insects in temperate alpine regions: Complementary modeling approaches applied to Swiss rivers",
    authors: ["Timoner, Pablo", "Fasel, Marc", "AshrafVaghefi, Seyed", "Marle, Pierre", "Castella, Emmanuel", "Moser, Frédéric", "Lehmann, Anthony"],
    year: 2021,
    month: 4,
    journal: "Global Change Biology",
    volume: "27",
    doi: "10.1111/gcb.15637"
  },
  {
    title: "Data Cube on Demand (DCoD): Generating an earth observation Data Cube anywhere in the world",
    authors: ["Giuliani, Gregory", "Chatenoux, Bruno", "Piller, Thomas", "Moser, Frédéric", "Lacroix, Pierre"],
    year: 2020,
    month: 5,
    journal: "International Journal of Applied Earth Observation and Geoinformation",
    volume: "87",
    doi: "10.1016/j.jag.2019.102035"
  },
  {
    title: "Assessing the Vulnerability of Aquatic Macroinvertebrates to Climate Warming in a Mountainous Watershed: Supplementing Presence-Only Data with Species Traits",
    authors: ["Monbertrand, Anne-Laure", "Timoner, Pablo", "Rahman, Kazi", "Burlando, Paolo", "Fatichi, Simone", "Gonseth, Yves", "Moser, Frédéric", "Castella, Emmanuel", "Lehmann, Anthony"],
    year: 2019,
    month: 3,
    journal: "Water",
    volume: "11",
    pages: "636",
    doi: "10.3390/w11040636"
  },
  {
    title: "MapX: An open geospatial platform to manage, analyze and visualize data on natural resources and the environment",
    authors: ["Lacroix, Pierre", "Moser, Frédéric", "Benvenuti, Antonio", "Piller, Thomas", "Jensen, David", "Petersen, Inga", "Planque, Marion", "Ray, Nicolas"],
    year: 2019,
    month: 1,
    journal: "SoftwareX",
    volume: "9",
    pages: "77-84",
    doi: "10.1016/j.softx.2019.01.002"
  }
];


