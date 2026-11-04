import { vaultPackages } from "../vault/packages";
import { TypstClient } from "./client";

/** The app's single compiler worker, shared by every open tab. */
export const typst = new TypstClient(vaultPackages);
