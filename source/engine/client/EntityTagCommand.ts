import { ConsoleCommand } from '../common/Cmd.ts';
import Con from '../common/Console.ts';
import { SkeletalModel } from '../common/model/SkeletalModel.ts';
import Vector from '../../shared/Vector.ts';
import { clientRuntimeState } from './ClientState.ts';
import { EntityTags } from './EntityTags.ts';

/**
 * `entitytag <entity number> [tag name]`: prints where a tag of an entity is in the world right now, with its angles.
 * Run it again while the entity moves and the numbers move with the pose. Without a tag name it lists the tags of the
 * entity's model. For checking where a weapon or an effect would sit, see `entities` for the numbers.
 */
export class EntityTagCommand extends ConsoleCommand {
  override run(entityNumber?: string, tagName?: string): void {
    if (entityNumber === undefined) {
      Con.Print(`Usage: ${this.command} <entity number> [tag name]\n`);
      return;
    }

    const number = Number.parseInt(entityNumber, 10);
    const entity = Number.isInteger(number) ? [...clientRuntimeState.clientEntities.getEntities()].find((candidate) => candidate.num === number && !candidate.free) : undefined;

    if (entity === undefined || entity.model === null) {
      Con.PrintError(`${this.command}: no entity ${entityNumber} with a model\n`);
      return;
    }

    const model = entity.model;

    if (!(model instanceof SkeletalModel)) {
      Con.PrintError(`${this.command}: ${model.name} has no tags\n`);
      return;
    }

    if (tagName === undefined) {
      Con.Print(`${model.name}: ${model.jointNames.join(', ')}\n`);
      return;
    }

    const origin = new Vector();
    const angles = new Vector();

    if (!EntityTags.resolve(entity, tagName, origin, angles)) {
      Con.PrintError(`${this.command}: ${model.name} has no tag ${tagName}\n`);
      return;
    }

    Con.Print(`${tagName} (${model.getTagIndex(tagName)}) of entity ${number}: origin ${origin.toString()}, angles ${angles.toString()}\n`);
  }
}
