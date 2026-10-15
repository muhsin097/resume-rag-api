import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthenticatedRecruiter {
  id: string;
  email: string;
}

export const CurrentRecruiter = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedRecruiter => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
