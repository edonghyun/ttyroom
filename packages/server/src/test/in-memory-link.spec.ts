import { makeInMemoryLink } from "./in-memory-link.js";
import { describeTransportContract } from "./transport-contract.js";

describeTransportContract("InMemoryLink", makeInMemoryLink);
