import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class RecruiterJwtAuthGuard extends AuthGuard('jwt-recruiter') {}
