import { IsEnum } from 'class-validator';
import { CreditPack } from '../../generated/prisma/enums.js';

export class CreateOrderDto {
  @IsEnum(CreditPack)
  pack!: CreditPack;
}
