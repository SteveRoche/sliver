import { TypstClient } from './client';

/** The app's single compiler connection, shared by every open tab. */
export const typst = new TypstClient();
