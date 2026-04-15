/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { PDFDocument, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import { GoogleGenAI, Type } from "@google/genai";
import { 
  Upload, 
  FileText, 
  Image as ImageIcon, 
  CheckCircle2, 
  Download, 
  Loader2, 
  AlertCircle,
  Trash2,
  User
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'motion/react';

// Set worker for pdfjs
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface Participant {
  name: string;
  pageIndex: number;
  cardIndex: number; // 0-7
  photo?: File;
  photoUrl?: string;
}

const AI_MODEL = "gemini-3-flash-preview"; // Using a supported fast model for OCR

export default function App() {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [isProcessingPdf, setIsProcessingPdf] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [uploadedPhotos, setUploadedPhotos] = useState<File[]>([]);

  const aiRef = useRef<GoogleGenAI | null>(null);

  useEffect(() => {
    if (process.env.GEMINI_API_KEY) {
      aiRef.current = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }
  }, []);

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPdfFile(file);
    setParticipants([]);
    setProcessingProgress(0);
    processPdf(file);
  };

  const processPdf = async (file: File) => {
    if (!aiRef.current) {
      toast.error("Gemini API Key tidak ditemukan.");
      return;
    }

    setIsProcessingPdf(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
      const numPages = pdf.numPages;
      const allParticipants: Participant[] = [];

      for (let i = 1; i <= numPages; i++) {
        setProcessingProgress(Math.round(((i - 1) / numPages) * 100));
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        if (context) {
          // @ts-ignore - pdfjs types can be tricky across versions
          await page.render({ canvasContext: context, viewport }).promise;
          const base64Image = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];

          const response = await aiRef.current.models.generateContent({
            model: AI_MODEL,
            contents: [
              {
                parts: [
                  {
                    inlineData: {
                      mimeType: "image/jpeg",
                      data: base64Image,
                    },
                  },
                  {
                    text: `Ekstrak nama peserta dari kartu login di gambar ini. 
                    Ada 8 kartu per halaman (2 kolom, 4 baris).
                    Urutkan dari baris pertama (kiri ke kanan), lalu baris kedua, dst.
                    Berikan output dalam format JSON array of strings. 
                    Hanya array nama saja.`,
                  },
                ],
              },
            ],
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.ARRAY,
                items: { type: Type.STRING }
              }
            }
          });

          const names = JSON.parse(response.text || "[]") as string[];
          names.forEach((name, idx) => {
            allParticipants.push({
              name: name.trim().toUpperCase(),
              pageIndex: i - 1,
              cardIndex: idx,
            });
          });
        }
      }

      setParticipants(allParticipants);
      setProcessingProgress(100);
      toast.success(`Berhasil mendeteksi ${allParticipants.length} peserta.`);
    } catch (error) {
      console.error(error);
      toast.error("Gagal memproses PDF. Pastikan file valid.");
    } finally {
      setIsProcessingPdf(false);
    }
  };

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const newPhotos = [...uploadedPhotos, ...files];
    setUploadedPhotos(newPhotos);

    // Match photos to participants
    const updatedParticipants = [...participants];
    files.forEach((file: File) => {
      const fileName = file.name.split('.').slice(0, -1).join('.').trim().toUpperCase();
      const matchIndex = updatedParticipants.findIndex(p => p.name === fileName);
      if (matchIndex !== -1) {
        updatedParticipants[matchIndex].photo = file;
        updatedParticipants[matchIndex].photoUrl = URL.createObjectURL(file);
      }
    });

    setParticipants(updatedParticipants);
    toast.info(`Berhasil mencocokkan ${files.length} foto.`);
  };

  const removePhoto = (index: number) => {
    const updatedParticipants = [...participants];
    if (updatedParticipants[index].photoUrl) {
      URL.revokeObjectURL(updatedParticipants[index].photoUrl!);
    }
    updatedParticipants[index].photo = undefined;
    updatedParticipants[index].photoUrl = undefined;
    setParticipants(updatedParticipants);
  };

  const generateFinalPdf = async () => {
    if (!pdfFile) return;
    setIsGeneratingPdf(true);

    try {
      const existingPdfBytes = await pdfFile.arrayBuffer();
      const pdfDoc = await PDFDocument.load(existingPdfBytes);
      const pages = pdfDoc.getPages();

      for (const participant of participants) {
        if (!participant.photo) continue;

        const page = pages[participant.pageIndex];
        const { width, height } = page.getSize();

        // Calculate coordinates for the "Foto" box
        // Based on the layout: 2 columns, 4 rows
        // We need to estimate the positions. 
        // A4 is 595 x 842.
        // Let's use relative positioning based on 8 cards.
        
        const colWidth = width / 2;
        const rowHeight = height / 4;
        
        const col = participant.cardIndex % 2;
        const row = Math.floor(participant.cardIndex / 2);

        // Resize to 1.33cm x 1.66cm size (approx 38x47 points)
        const boxWidth = 38;
        const boxHeight = 47;
        
        // Adjusted coordinates to place the 1.33x1.66 photo in the "Foto" box
        // Shifted down by 0.9cm (~25.5 points) from the reference top position
        const offsetX = 115; 
        const offsetY = -1; 

        // pdf-lib uses bottom-left as (0,0)
        const x = (col * colWidth) + offsetX;
        const y = height - ((row + 1) * rowHeight) + offsetY;

        const photoBytes = await participant.photo.arrayBuffer();
        let image;
        if (participant.photo.type === 'image/jpeg') {
          image = await pdfDoc.embedJpg(photoBytes);
        } else {
          image = await pdfDoc.embedPng(photoBytes);
        }

        page.drawImage(image, {
          x,
          y,
          width: boxWidth,
          height: boxHeight,
        });
      }

      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `TKAD_With_Photos_${new Date().getTime()}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success("PDF berhasil diunduh!");
    } catch (error) {
      console.error(error);
      toast.error("Gagal menghasilkan PDF.");
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  return (
    <div className="min-h-screen text-[#f8fafc] font-sans flex flex-col">
      {/* Header */}
      <header className="h-[70px] px-10 flex items-center justify-between border-b border-glass-border backdrop-blur-md sticky top-0 z-50">
        <div className="text-xl font-extrabold tracking-tighter text-accent-primary">
          TKAD.AutoCard
        </div>
        <div className="flex items-center gap-4">
          <Button variant="outline" className="border-glass-border text-text-main hover:bg-white/5 rounded-xl">
            Panduan OCR
          </Button>
          {participants.some(p => p.photo) && (
            <Button 
              onClick={generateFinalPdf} 
              disabled={isGeneratingPdf}
              className="bg-accent-primary text-[#0f172a] hover:bg-accent-primary/90 rounded-xl font-semibold px-6"
            >
              {isGeneratingPdf ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Download className="w-4 h-4 mr-2" />}
              Unduh PDF Final ({participants.filter(p => p.photo).length}/{participants.length})
            </Button>
          )}
        </div>
      </header>

      <main className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6 p-8 flex-1">
        {/* Sidebar */}
        <aside className="glass-panel rounded-[20px] p-6 space-y-8 h-fit">
          <section>
            <span className="text-[10px] uppercase tracking-widest text-accent-primary mb-2 block font-semibold">
              Langkah 1 & 2
            </span>
            <h3 className="text-lg font-semibold mb-5">Upload & Deteksi</h3>
            
            <div className="upload-zone rounded-xl p-8 text-center cursor-pointer relative group">
              <input 
                type="file" 
                accept=".pdf" 
                onChange={handlePdfUpload}
                className="absolute inset-0 opacity-0 cursor-pointer"
                disabled={isProcessingPdf}
              />
              <Upload className="w-8 h-8 text-accent-primary/50 mx-auto mb-3 group-hover:text-accent-primary transition-colors" />
              <p className="text-sm font-medium">
                {pdfFile ? pdfFile.name : "Upload File TKAD.pdf"}
              </p>
              {pdfFile && (
                <p className="text-[11px] text-text-dim mt-1">
                  {(pdfFile.size / (1024 * 1024)).toFixed(1)} MB
                </p>
              )}
            </div>

            {isProcessingPdf && (
              <div className="mt-4 space-y-2">
                <div className="flex justify-between text-[10px] font-semibold uppercase tracking-wider text-text-dim">
                  <span>Memproses OCR...</span>
                  <span>{processingProgress}%</span>
                </div>
                <Progress value={processingProgress} className="h-1.5 bg-white/5" indicatorClassName="bg-accent-primary" />
              </div>
            )}

            <div className="mt-6 space-y-3">
              {pdfFile && !isProcessingPdf && participants.length > 0 && (
                <div className="flex items-center gap-3 py-2 border-b border-glass-border text-sm">
                  <div className="w-2 h-2 rounded-full bg-[#22c55e]" />
                  <span>OCR Selesai: {participants.length} Peserta</span>
                </div>
              )}
              {pdfFile && (
                <div className="flex items-center gap-3 py-2 border-b border-glass-border text-sm">
                  <div className="w-2 h-2 rounded-full bg-[#22c55e]" />
                  <span>Layout: A4 Multi-page</span>
                </div>
              )}
            </div>
          </section>

          <section>
            <span className="text-[10px] uppercase tracking-widest text-accent-primary mb-2 block font-semibold">
              Langkah 3 & 4
            </span>
            <h3 className="text-lg font-semibold mb-5">Bulk Upload Foto</h3>
            <div className="upload-zone rounded-xl p-6 text-center cursor-pointer relative group">
              <input 
                id="photo-upload" 
                type="file" 
                multiple 
                accept="image/*" 
                onChange={handlePhotoUpload}
                disabled={participants.length === 0}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
              <p className="text-sm font-medium">Pilih Folder Foto</p>
              <p className="text-[10px] text-text-dim mt-1">
                Nama file harus sesuai Nama Peserta
              </p>
            </div>
          </section>
        </aside>

        {/* Main Content */}
        <section className="glass-panel rounded-[20px] p-6 flex flex-col h-[calc(100vh-134px)]">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-lg font-semibold">Daftar Peserta & Status Foto</h3>
            <span className="text-[10px] font-bold text-accent-primary bg-accent-primary/10 px-3 py-1 rounded-full uppercase tracking-wider">
              Matching Otomatis Aktif
            </span>
          </div>

          <ScrollArea className="flex-1 pr-4">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <AnimatePresence>
                {participants.map((p, idx) => (
                  <motion.div 
                    key={`${p.name}-${idx}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="bg-white/[0.03] border border-glass-border rounded-xl p-4 flex items-center gap-4 group hover:bg-white/[0.05] transition-all"
                  >
                    <div className={`w-[50px] h-[65px] rounded-md flex-shrink-0 flex items-center justify-center text-[10px] border border-glass-border overflow-hidden ${
                      p.photoUrl ? 'bg-accent-primary text-[#0f172a] font-bold' : 'bg-[#1e293b] text-text-dim'
                    }`}>
                      {p.photoUrl ? (
                        <img src={p.photoUrl} alt={p.name} className="w-full h-full object-cover" />
                      ) : (
                        "-"
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-semibold truncate uppercase">{p.name}</h4>
                      <p className="text-[11px] text-text-dim">
                        Hal {p.pageIndex + 1} • {p.photo ? p.photo.name : "Menunggu Upload..."}
                      </p>
                    </div>
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      p.photo ? 'bg-[#22c55e]' : 'bg-[#eab308]'
                    }`} />
                    {p.photo && (
                      <button 
                        onClick={() => removePhoto(idx)}
                        className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 transition-all p-1"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
              {participants.length === 0 && (
                <div className="col-span-full flex flex-col items-center justify-center py-32 text-text-dim">
                  <AlertCircle className="w-12 h-12 mb-4 opacity-10" />
                  <p className="text-sm">Upload PDF terlebih dahulu untuk melihat daftar peserta</p>
                </div>
              )}
            </div>
          </ScrollArea>
        </section>
      </main>
      <Toaster position="top-center" theme="dark" />
    </div>
  );
}
