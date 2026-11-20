import { Module } from '@nestjs/common';
import { WordsModule } from '../words/words.module.js';
import { WrongNotesController } from './wrong-notes.controller.js';
import { WrongNotesService } from './wrong-notes.service.js';

@Module({
  imports: [WordsModule],
  controllers: [WrongNotesController],
  providers: [WrongNotesService],
})
export class WrongNotesModule {}
