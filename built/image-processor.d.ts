import { type Sharp, type WebpOptions } from 'sharp';
import { Readable } from 'node:stream';
export type IImage = {
    data: Buffer;
    ext: string | null;
    type: string;
};
export type IImageStream = {
    data: Readable;
    ext: string | null;
    type: string;
};
export type IImageStreamable = IImage | IImageStream;
export declare const webpDefault: WebpOptions;
export declare function convertToWebpStream(path: string, width: number, height: number, options?: WebpOptions): IImageStream;
export declare function convertSharpToWebpStream(sharp: Sharp, width: number, height: number, options?: WebpOptions): IImageStream;
