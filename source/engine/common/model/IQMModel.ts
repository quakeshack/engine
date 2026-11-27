import { SkeletalModel } from './SkeletalModel.ts';

/**
 * A model loaded from an Inter-Quake Model file (version 2). See `IQMLoader` for the layout of the file.
 */
export class IQMModel extends SkeletalModel {
  override get formatName(): string {
    return 'Inter-Quake Model v2';
  }
}
