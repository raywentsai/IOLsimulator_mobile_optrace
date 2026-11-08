import backgroundUrl from '../assets/images/background.jpg';
import backgroundInfo from '../assets/images/background.json';
import {AssetError,loadJpegAsset,type ProgressListener,type LoadedImage} from './asset-loading';

const backgroundTransferMs=120_000;

export async function loadBackgroundAsset(signal:AbortSignal,onProgress?:ProgressListener):Promise<LoadedImage> {
  const asset=await loadJpegAsset(backgroundUrl,signal,{
    expectedBytes:backgroundInfo.bytes,totalMs:backgroundTransferMs,nativeMs:backgroundTransferMs,onProgress
  });
  if(asset.image.naturalWidth!==backgroundInfo.width||asset.image.naturalHeight!==backgroundInfo.height){
    asset.release();
    throw new AssetError('decode',`${backgroundUrl}: unexpected background dimensions`);
  }
  return asset;
}
